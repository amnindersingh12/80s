import { IntervalLimiter } from "../lib/concurrency.js";
import { requestJson, sleep, type FetchFn } from "../lib/http.js";
import { AppError } from "../errors.js";
import { artistSimilarity } from "../lib/text.js";
import { rankScore, type TrackCandidate } from "./types.js";

interface MbArtist {
  id: string;
  name: string;
  score?: number;
  tags?: Array<{ name: string; count?: number }>;
  genres?: Array<{ name: string; count?: number }>;
}

interface MbRecording {
  id: string;
  title: string;
  length?: number;
  "artist-credit"?: Array<{ name?: string; joinphrase?: string; artist?: { name?: string } }>;
  releases?: Array<{ id: string; title?: string }>;
}

/**
 * MusicBrainz WS/2 client. MusicBrainz requires a descriptive User-Agent and
 * allows ~1 request/second, so every call goes through a shared limiter.
 */
export class MusicBrainzClient {
  private readonly limiter: IntervalLimiter;

  constructor(
    private readonly opts: { baseUrl: string; userAgent: string; timeoutMs: number; fetch?: FetchFn; intervalMs?: number },
  ) {
    this.limiter = new IntervalLimiter(opts.intervalMs ?? 1_100);
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = new URL(`${this.opts.baseUrl.replace(/\/+$/, "")}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("fmt", "json");
    const attempt = () =>
      this.limiter.schedule(() =>
        requestJson<T>(url.toString(), {
          timeoutMs: this.opts.timeoutMs,
          retries: 0,
          fetch: this.opts.fetch,
          headers: { "user-agent": this.opts.userAgent },
          label: "MusicBrainz",
        }),
      );
    let res;
    try {
      res = await attempt();
    } catch (err) {
      // 503 is MusicBrainz's rate-limit signal: back off once.
      if (!(err instanceof AppError) || err.upstreamStatus !== 503) throw err;
      await sleep(1_500);
      res = await attempt();
    }
    if (res.status === 404) return {} as T;
    if (res.status >= 400) throw new AppError("UPSTREAM_BAD_RESPONSE", `MusicBrainz HTTP ${res.status}`, { upstreamStatus: res.status });
    return res.data;
  }

  /** Best artist match for a name (requires a confident score and name similarity). */
  async findArtist(name: string): Promise<{ mbid: string; name: string } | undefined> {
    const data = await this.get<{ artists?: MbArtist[] }>("/artist", {
      query: `artist:"${name.replace(/"/g, "")}"`,
      limit: "5",
    });
    const best = (data.artists ?? []).find((a) => (a.score ?? 0) >= 80 && artistSimilarity(a.name, name) >= 0.85);
    return best ? { mbid: best.id, name: best.name } : undefined;
  }

  /** Genres (preferred) or folksonomy tags for an artist, most-voted first. */
  async artistTags(mbid: string, limit = 8): Promise<string[]> {
    const a = await this.get<MbArtist>(`/artist/${encodeURIComponent(mbid)}`, { inc: "genres tags" });
    const list = (a.genres?.length ? a.genres : a.tags) ?? [];
    return [...list]
      .sort((x, y) => (y.count ?? 0) - (x.count ?? 0))
      .map((t) => t.name.toLowerCase())
      .slice(0, limit);
  }

  /** Recordings carrying a tag — the keyless last resort for genre seeds. */
  async recordingsByTag(tag: string, limit = 25, reason?: string): Promise<TrackCandidate[]> {
    const data = await this.get<{ recordings?: MbRecording[] }>("/recording", {
      query: `tag:"${tag.replace(/"/g, "")}"`,
      limit: String(limit),
    });
    const list = data.recordings ?? [];
    return list
      .map((r, i): TrackCandidate | null => {
        const artist = (r["artist-credit"] ?? []).map((c) => `${c.name ?? c.artist?.name ?? ""}${c.joinphrase ?? ""}`).join("").trim();
        if (!r.title || !artist) return null;
        const release = r.releases?.[0];
        return {
          title: r.title,
          artist,
          mbid: r.id,
          ...(release?.title ? { album: release.title } : {}),
          ...(r.length ? { durationSec: Math.round(r.length / 1000) } : {}),
          score: rankScore(i, list.length) * 0.8,
          source: "musicbrainz",
          ...(reason ? { reason } : {}),
        };
      })
      .filter((t): t is TrackCandidate => t !== null);
  }
}
