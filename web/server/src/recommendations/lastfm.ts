import { AppError } from "../errors.js";
import { requestJson, type FetchFn } from "../lib/http.js";
import { rankScore, type ArtistCandidate, type TrackCandidate } from "./types.js";

interface LfmImage {
  "#text"?: string;
  size?: string;
}
interface LfmArtistRef {
  name?: string;
  mbid?: string;
}
interface LfmTrack {
  name?: string;
  mbid?: string;
  match?: number | string;
  duration?: number | string;
  artist?: LfmArtistRef | string;
  image?: LfmImage[];
}
interface LfmArtist {
  name?: string;
  mbid?: string;
  match?: number | string;
  image?: LfmImage[];
}

/** Last.fm serves this star placeholder instead of real artist/track art. */
const PLACEHOLDER = "2a96cbd8b46e442fc41c2b86b821562f";

function image(images: LfmImage[] | undefined): string | undefined {
  const url = images?.find((i) => i.size === "extralarge")?.["#text"] ?? images?.at(-1)?.["#text"];
  return url && !url.includes(PLACEHOLDER) ? url : undefined;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

export class LastfmClient {
  constructor(
    private readonly opts: { apiKey: string; baseUrl: string; timeoutMs: number; fetch?: FetchFn },
  ) {}

  private async call(method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    const url = new URL(`${this.opts.baseUrl.replace(/\/+$/, "")}/`);
    url.searchParams.set("method", method);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("api_key", this.opts.apiKey);
    url.searchParams.set("format", "json");
    url.searchParams.set("autocorrect", "1");
    const res = await requestJson<Record<string, unknown>>(url.toString(), {
      timeoutMs: this.opts.timeoutMs,
      retries: 1,
      fetch: this.opts.fetch,
      label: `Last.fm ${method}`,
    });
    const data = res.data ?? {};
    if (typeof data.error === "number") {
      // 6 = "not found" (unknown artist/track/tag) → empty result, not an outage.
      if (data.error === 6) return {};
      throw new AppError("UPSTREAM_BAD_RESPONSE", `Last.fm ${method}: ${String(data.message ?? data.error)}`, { upstreamStatus: res.status });
    }
    if (res.status >= 400) throw new AppError("UPSTREAM_BAD_RESPONSE", `Last.fm ${method} HTTP ${res.status}`, { upstreamStatus: res.status });
    return data;
  }

  private mapTracks(list: LfmTrack[], scoreOf: (t: LfmTrack, i: number) => number, reason?: string): TrackCandidate[] {
    return list
      .map((t, i): TrackCandidate | null => {
        const artist = typeof t.artist === "string" ? t.artist : t.artist?.name;
        if (!t.name || !artist) return null;
        const duration = Number(t.duration);
        return {
          title: t.name,
          artist,
          ...(t.mbid ? { mbid: t.mbid } : {}),
          ...(duration > 0 ? { durationSec: duration > 10_000 ? Math.round(duration / 1000) : duration } : {}),
          ...(image(t.image) ? { coverUrl: image(t.image) } : {}),
          score: Math.max(0, Math.min(1, scoreOf(t, i))),
          source: "lastfm",
          ...(reason ? { reason } : {}),
        };
      })
      .filter((t): t is TrackCandidate => t !== null);
  }

  async similarTracks(artist: string, title: string, limit = 50): Promise<TrackCandidate[]> {
    const data = await this.call("track.getSimilar", { artist, track: title, limit: String(limit) });
    const list = asArray((data.similartracks as { track?: LfmTrack[] } | undefined)?.track);
    return this.mapTracks(list, (t, i) => Number(t.match) || rankScore(i, list.length), `Similar to ${title}`);
  }

  async similarArtists(artist: string, limit = 20): Promise<ArtistCandidate[]> {
    const data = await this.call("artist.getSimilar", { artist, limit: String(limit) });
    const list = asArray((data.similarartists as { artist?: LfmArtist[] } | undefined)?.artist);
    return list
      .filter((a) => a.name)
      .map((a, i) => ({
        name: a.name as string,
        ...(a.mbid ? { mbid: a.mbid } : {}),
        ...(image(a.image) ? { imageUrl: image(a.image) } : {}),
        score: Number(a.match) || rankScore(i, list.length),
        source: "lastfm" as const,
      }));
  }

  async artistTopTracks(artist: string, limit = 10, reason?: string): Promise<TrackCandidate[]> {
    const data = await this.call("artist.getTopTracks", { artist, limit: String(limit) });
    const list = asArray((data.toptracks as { track?: LfmTrack[] } | undefined)?.track);
    return this.mapTracks(list, (_, i) => rankScore(i, list.length), reason ?? `Top track by ${artist}`);
  }

  async artistTopTags(artist: string, limit = 8): Promise<string[]> {
    const data = await this.call("artist.getTopTags", { artist });
    const list = asArray((data.toptags as { tag?: Array<{ name?: string }> } | undefined)?.tag);
    return list.map((t) => t.name?.toLowerCase()).filter((t): t is string => Boolean(t)).slice(0, limit);
  }

  async tagTopTracks(tag: string, limit = 50): Promise<TrackCandidate[]> {
    const data = await this.call("tag.getTopTracks", { tag, limit: String(limit) });
    const list = asArray((data.tracks as { track?: LfmTrack[] } | undefined)?.track);
    return this.mapTracks(list, (_, i) => rankScore(i, list.length), `Top ${tag}`);
  }

  async tagTopArtists(tag: string, limit = 20): Promise<ArtistCandidate[]> {
    const data = await this.call("tag.getTopArtists", { tag, limit: String(limit) });
    const list = asArray((data.topartists as { artist?: LfmArtist[] } | undefined)?.artist);
    return list
      .filter((a) => a.name)
      .map((a, i) => ({
        name: a.name as string,
        ...(a.mbid ? { mbid: a.mbid } : {}),
        score: rankScore(i, list.length),
        source: "lastfm" as const,
      }));
  }
}
