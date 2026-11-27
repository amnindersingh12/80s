import { requestJson, type FetchFn } from "../lib/http.js";
import { AppError } from "../errors.js";
import { rankScore, type ArtistCandidate, type TrackCandidate } from "./types.js";

interface LbRadioRecording {
  recording_mbid: string;
  similar_artist_mbid?: string;
  similar_artist_name?: string;
  total_listen_count?: number;
}

interface LbSimilarArtist {
  artist_mbid: string;
  name: string;
  score?: number;
}

/** Dataset name used by listenbrainz.org's own "similar artists" pages; override via env if it changes. */
export const DEFAULT_SIMILAR_ALGORITHM = "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30";

interface LbRecordingMeta {
  recording?: { name?: string; length?: number };
  artist?: { name?: string };
  release?: { name?: string; caa_release_mbid?: string; caa_id?: number };
}

/**
 * ListenBrainz LB Radio + metadata endpoints. All of these work anonymously;
 * `LISTENBRAINZ_TOKEN` is sent when configured (higher rate limits).
 */
export class ListenBrainzClient {
  constructor(
    private readonly opts: { baseUrl: string; labsBaseUrl?: string; similarAlgorithm?: string; token?: string; timeoutMs: number; fetch?: FetchFn },
  ) {}

  private async get<T>(path: string, params: Record<string, string | string[]>, base = this.opts.baseUrl): Promise<T> {
    const url = new URL(`${base.replace(/\/+$/, "")}${path}`);
    for (const [k, v] of Object.entries(params)) {
      for (const value of Array.isArray(v) ? v : [v]) url.searchParams.append(k, value);
    }
    const res = await requestJson<T>(url.toString(), {
      timeoutMs: this.opts.timeoutMs,
      retries: 1,
      fetch: this.opts.fetch,
      headers: this.opts.token ? { authorization: `Token ${this.opts.token}` } : {},
      label: `ListenBrainz ${path.split("/").slice(0, 3).join("/")}`,
    });
    if (res.status === 404 || res.status === 400) return (Array.isArray(res.data) ? [] : {}) as T;
    if (res.status >= 400) throw new AppError("UPSTREAM_BAD_RESPONSE", `ListenBrainz HTTP ${res.status}`, { upstreamStatus: res.status });
    return res.data;
  }

  /** Similar artists and their recordings, seeded by an artist MBID. */
  async artistRadio(
    artistMbid: string,
    options: { maxSimilarArtists?: number; maxRecordingsPerArtist?: number; reason?: string } = {},
  ): Promise<{ artists: ArtistCandidate[]; tracks: TrackCandidate[] }> {
    const [data, similar] = await Promise.all([
      this.get<Record<string, LbRadioRecording[]>>(`/1/lb-radio/artist/${encodeURIComponent(artistMbid)}`, {
        mode: "easy",
        max_similar_artists: String(options.maxSimilarArtists ?? 12),
        max_recordings_per_artist: String((options.maxRecordingsPerArtist ?? 3) * 2),
        pop_begin: "0",
        pop_end: "100",
      }),
      // LB Radio answers with an object keyed by MBID (i.e. alphabetical), so similarity
      // order comes from the similar-artists dataset; popularity is the fallback.
      this.similarArtists(artistMbid).catch(() => [] as LbSimilarArtist[]),
    ]);
    const rank = new Map(similar.map((a, i) => [a.artist_mbid, i]));
    const listens = (recs: LbRadioRecording[]) => recs.reduce((m, r) => Math.max(m, r.total_listen_count ?? 0), 0);
    const groups = Object.entries(data ?? {})
      .filter(([, recs]) => Array.isArray(recs) && recs.length)
      .sort(([a, ra], [b, rb]) => {
        if (a === artistMbid) return -1; // "more by this artist" first
        if (b === artistMbid) return 1;
        return (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || listens(rb) - listens(ra);
      });

    const named = new Map<string, string>();
    for (const [mbid, recs] of groups) if (recs[0]?.similar_artist_name) named.set(mbid, recs[0].similar_artist_name);
    for (const a of similar) if (a.name && !named.has(a.artist_mbid)) named.set(a.artist_mbid, a.name);
    const ordered = [
      ...groups.map(([mbid]) => mbid).filter((m) => m !== artistMbid),
      ...similar.map((a) => a.artist_mbid).filter((m) => m !== artistMbid && !data?.[m]),
    ].slice(0, 15);
    const artists: ArtistCandidate[] = ordered
      .map((mbid, i) => ({ name: named.get(mbid) ?? "", mbid, score: rankScore(i, ordered.length), source: "listenbrainz" as const }))
      .filter((a) => a.name);

    const ranked: Array<{ mbid: string; score: number; artist?: string }> = [];
    const keep = options.maxRecordingsPerArtist ?? 3;
    groups.forEach(([, recs], gi) => {
      // Prefer each artist's most-listened recordings (LB Radio otherwise picks deep cuts).
      const best = [...recs].sort((a, b) => (b.total_listen_count ?? 0) - (a.total_listen_count ?? 0)).slice(0, keep);
      best.forEach((r, ri) => {
        ranked.push({
          mbid: r.recording_mbid,
          score: rankScore(gi, groups.length) * (1 - ri * 0.08),
          artist: r.similar_artist_name,
        });
      });
    });
    const tracks = await this.hydrate(ranked, options.reason);
    return { artists, tracks };
  }

  /** Similar artists with scores from the ListenBrainz Labs similarity dataset. */
  async similarArtists(artistMbid: string): Promise<LbSimilarArtist[]> {
    const data = await this.get<LbSimilarArtist[]>(
      "/similar-artists/json",
      { artist_mbids: artistMbid, algorithm: this.opts.similarAlgorithm ?? DEFAULT_SIMILAR_ALGORITHM },
      this.opts.labsBaseUrl ?? "https://labs.api.listenbrainz.org",
    );
    return (Array.isArray(data) ? data : []).filter((a) => a && a.artist_mbid && a.name).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  /** Recordings for one or more tags (MusicBrainz folksonomy). */
  async tagRadio(tags: string[], count = 50, reason?: string): Promise<TrackCandidate[]> {
    const data = await this.get<Array<{ recording_mbid: string; percent?: number }>>("/1/lb-radio/tags", {
      tag: tags,
      operator: "or",
      pop_begin: "0",
      pop_end: "100",
      count: String(count),
    });
    const list = Array.isArray(data) ? data : [];
    return this.hydrate(
      list.map((r, i) => ({ mbid: r.recording_mbid, score: rankScore(i, list.length) })),
      reason,
    );
  }

  /** Turns recording MBIDs into titles/artists/cover art (batched). */
  private async hydrate(ranked: Array<{ mbid: string; score: number; artist?: string }>, reason?: string): Promise<TrackCandidate[]> {
    const unique = [...new Map(ranked.filter((r) => r.mbid).map((r) => [r.mbid, r])).values()].slice(0, 100);
    const out: TrackCandidate[] = [];
    for (let i = 0; i < unique.length; i += 25) {
      const batch = unique.slice(i, i + 25);
      const meta = await this.get<Record<string, LbRecordingMeta>>("/1/metadata/recording/", {
        recording_mbids: batch.map((b) => b.mbid).join(","),
        inc: "artist release",
      });
      for (const b of batch) {
        const m = meta?.[b.mbid];
        const title = m?.recording?.name;
        const artist = m?.artist?.name ?? b.artist;
        if (!title || !artist) continue;
        const caa = m?.release?.caa_release_mbid;
        out.push({
          title,
          artist,
          mbid: b.mbid,
          ...(m?.release?.name ? { album: m.release.name } : {}),
          ...(m?.recording?.length ? { durationSec: Math.round(m.recording.length / 1000) } : {}),
          ...(caa && m?.release?.caa_id ? { coverUrl: `https://coverartarchive.org/release/${caa}/front-250` } : {}),
          score: b.score,
          source: "listenbrainz",
          ...(reason ? { reason } : {}),
        });
      }
    }
    return out;
  }
}
