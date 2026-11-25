import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../errors.js";
import { joinUrl, requestJson, type FetchFn } from "../lib/http.js";
import type { SubsonicConfig } from "../config.js";
import {
  MIME_BY_EXTENSION,
  inferLossless,
  type AudioProvider,
  type ProviderTrack,
  type SearchOptions,
  type StreamSource,
} from "./types.js";

interface SubsonicSong {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  duration?: number;
  coverArt?: string;
  suffix?: string;
  contentType?: string;
  bitRate?: number;
  bitDepth?: number;
  samplingRate?: number;
  year?: number;
  track?: number;
  isrc?: string[] | string;
}

interface SubsonicEnvelope {
  "subsonic-response"?: {
    status: "ok" | "failed";
    error?: { code: number; message?: string };
    searchResult3?: { song?: SubsonicSong[] };
    song?: SubsonicSong;
  };
}

/**
 * Fallback provider for any OpenSubsonic-compatible server (Navidrome,
 * Gonic, Airsonic…). Streams the original file with `format=raw`, so FLAC
 * stays bit-perfect. Auth uses the OpenSubsonic `apiKey` extension when set,
 * otherwise salted token auth (`t = md5(password + salt)`).
 */
export class SubsonicProvider implements AudioProvider {
  readonly name: string;
  readonly kind = "opensubsonic";
  private readonly fetchFn: FetchFn;

  constructor(
    private readonly cfg: SubsonicConfig,
    options: { fetch?: FetchFn; name?: string } = {},
  ) {
    this.fetchFn = options.fetch ?? fetch;
    this.name = options.name ?? "subsonic";
  }

  async search(query: string, options: SearchOptions = {}): Promise<ProviderTrack[]> {
    const body = await this.call("search3", {
      query,
      songCount: String(options.limit ?? 25),
      artistCount: "0",
      albumCount: "0",
    }, options.signal);
    return (body.searchResult3?.song ?? []).map((s) => this.mapSong(s));
  }

  async getTrackMetadata(id: string): Promise<ProviderTrack | null> {
    try {
      const body = await this.call("getSong", { id });
      return body.song ? this.mapSong(body.song) : null;
    } catch (err) {
      if (err instanceof AppError && err.code === "NOT_FOUND") return null;
      throw err;
    }
  }

  async getStreamUrl(id: string): Promise<StreamSource> {
    const meta = await this.getTrackMetadata(id);
    if (!meta) throw new AppError("NOT_FOUND", "Track not found on the fallback server", { provider: this.name });
    const ext = meta.format ?? "flac";
    return {
      // Credentials live in the query string, which is why streams are always proxied.
      url: this.url("stream", { id, format: "raw", estimateContentLength: "true" }),
      mimeType: MIME_BY_EXTENSION[ext] ?? "application/octet-stream",
      extension: ext,
    };
  }

  async getCoverSource(coverId: string): Promise<StreamSource> {
    return { url: this.url("getCoverArt", { id: coverId, size: "300" }), mimeType: "image/jpeg" };
  }

  private mapSong(s: SubsonicSong): ProviderTrack {
    const format = s.suffix?.toLowerCase();
    const isrc = Array.isArray(s.isrc) ? s.isrc[0] : s.isrc;
    const track: ProviderTrack = {
      id: String(s.id),
      provider: this.name,
      title: s.title ?? "Untitled",
      artist: s.artist ?? "Unknown artist",
      lossless: inferLossless(format, undefined, false),
    };
    if (s.album) track.album = s.album;
    if (s.duration !== undefined) track.durationSec = s.duration;
    if (s.coverArt) track.coverUrl = `/api/cover/${encodeURIComponent(`${this.name}:${s.coverArt}`)}`;
    if (format) track.format = format;
    if (s.bitDepth) track.bitDepth = s.bitDepth;
    if (s.samplingRate) track.sampleRate = s.samplingRate;
    if (s.bitRate) track.bitrateKbps = s.bitRate;
    if (s.year) track.year = s.year;
    if (s.track) track.trackNumber = s.track;
    if (isrc) track.isrc = isrc;
    return track;
  }

  private url(method: string, params: Record<string, string>): string {
    const u = new URL(joinUrl(this.cfg.baseUrl, `/rest/${method}.view`));
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set("v", "1.16.1");
    u.searchParams.set("c", this.cfg.client);
    u.searchParams.set("f", "json");
    if (this.cfg.apiKey) {
      u.searchParams.set("apiKey", this.cfg.apiKey);
    } else {
      const salt = randomBytes(8).toString("hex");
      u.searchParams.set("u", this.cfg.user ?? "");
      u.searchParams.set("s", salt);
      u.searchParams.set("t", createHash("md5").update(`${this.cfg.password ?? ""}${salt}`).digest("hex"));
    }
    return u.toString();
  }

  private async call(
    method: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<NonNullable<SubsonicEnvelope["subsonic-response"]>> {
    const res = await requestJson<SubsonicEnvelope>(this.url(method, params), {
      timeoutMs: this.cfg.timeoutMs,
      retries: 0,
      signal,
      fetch: this.fetchFn,
      label: `Subsonic ${method}`,
      provider: this.name,
    });
    const body = res.data?.["subsonic-response"];
    if (res.status === 401 || res.status === 403) {
      throw new AppError("UPSTREAM_AUTH_FAILED", "Fallback server rejected the credentials", { upstreamStatus: res.status, provider: this.name });
    }
    if (!body) throw new AppError("UPSTREAM_BAD_RESPONSE", `Subsonic ${method} returned no payload`, { upstreamStatus: res.status, provider: this.name });
    if (body.status !== "ok") {
      const code = body.error?.code;
      if (code === 70) throw new AppError("NOT_FOUND", "Not found on the fallback server", { provider: this.name });
      if (code === 40 || code === 41 || code === 44) {
        throw new AppError("UPSTREAM_AUTH_FAILED", "Fallback server rejected the credentials", { provider: this.name });
      }
      throw new AppError("UPSTREAM_BAD_RESPONSE", `Subsonic ${method} failed (code ${code ?? "?"})`, { provider: this.name });
    }
    return body;
  }
}
