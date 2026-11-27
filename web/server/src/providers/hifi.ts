import { AppError } from "../errors.js";
import { parseRetryAfterMs, requestJson, type FetchFn } from "../lib/http.js";
import {
  inferLossless,
  parseFlacStreamInfo,
  verifyLosslessStream,
  type AudioProvider,
  type ProviderTrack,
  type SearchOptions,
  type StreamOptions,
  type StreamSource,
} from "./types.js";

export interface HiFiPoolOptions {
  instances: string[];
  timeoutMs?: number;
  cooldownMs?: number;
  fetch?: FetchFn;
  now?: () => number;
  name?: string;
}

interface RawTracksItem {
  id?: string | number;
  trackId?: string | number;
  title?: string;
  artistNames?: string[];
  artists?: Array<{ name?: string }>;
  artist?: { name?: string } | string;
  album?: { title?: string; name?: string; cover?: string; releaseDate?: string; year?: number };
  albumTitle?: string;
  artwork?: string;
  artworkUrl?: string;
  cover?: string;
  coverUrl?: string;
  duration?: number;
  durationMs?: number;
  trackNumber?: number;
  track_number?: number;
  year?: number;
  releaseDate?: string;
  release_date?: string;
  format?: string;
  codec?: string;
  audioQuality?: string;
  quality?: string;
  bitDepth?: number;
  bit_depth?: number;
  sampleRate?: number;
  sample_rate?: number;
  bitrateKbps?: number;
  fileSize?: number;
  file_size?: number;
  size?: number;
  isrc?: string;
}

/**
 * No-login lossless provider pooling `tracks.monochrome.st` / `hifi-api` instances
 * with round-robin selection and per-instance cooldown on 429/403/5xx.
 */
export class HiFiPoolProvider implements AudioProvider {
  readonly name: string;
  readonly kind = "hifi-pool";

  private readonly instances: string[];
  private readonly timeoutMs: number;
  private readonly cooldownMs: number;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly openUntil = new Map<string, number>();
  private readonly metaCache = new Map<string, ProviderTrack>();
  private rrIndex = 0;

  constructor(options: HiFiPoolOptions) {
    this.instances = options.instances.map((u) => u.replace(/\/+$/, "")).filter(Boolean);
    if (this.instances.length === 0) throw new Error("HiFiPoolProvider requires at least one instance URL");
    this.name = options.name ?? "hifi";
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async search(query: string, options: SearchOptions = {}): Promise<ProviderTrack[]> {
    const limit = options.limit ?? 25;
    let lastErr: unknown;
    for (const base of this.pickOrder()) {
      try {
        const url = `${base}/search/tracks?q=${encodeURIComponent(query)}&limit=${limit}`;
        const res = await requestJson<{ tracks?: RawTracksItem[]; items?: RawTracksItem[]; data?: { items?: RawTracksItem[] } }>(url, {
          timeoutMs: this.timeoutMs,
          retries: 0,
          signal: options.signal,
          fetch: this.fetchFn,
          label: "HiFi search",
          provider: this.name,
        });
        if (res.status === 429 || res.status === 403 || res.status >= 500) {
          const retryAfterMs = res.status === 429 ? parseRetryAfterMs(res.headers, res.data, this.cooldownMs) : this.cooldownMs;
          this.markDown(base, retryAfterMs);
          lastErr = new AppError("UPSTREAM_UNAVAILABLE", `HiFi instance ${base} returned HTTP ${res.status}`, {
            upstreamStatus: res.status,
            provider: this.name,
            retryAfterMs,
          });
          continue;
        }
        if (res.status < 200 || res.status >= 300) {
          throw new AppError("UPSTREAM_BAD_RESPONSE", `HiFi search failed with HTTP ${res.status}`, {
            upstreamStatus: res.status,
            provider: this.name,
          });
        }
        this.openUntil.delete(base);
        const items = res.data?.tracks ?? res.data?.items ?? res.data?.data?.items ?? [];
        return items.map((item) => this.mapTrack(item)).filter((t): t is ProviderTrack => t !== null).slice(0, limit);
      } catch (err) {
        if (err instanceof AppError && err.code === "UPSTREAM_BAD_RESPONSE") throw err;
        this.markDown(base, err instanceof AppError && err.retryAfterMs ? err.retryAfterMs : this.cooldownMs);
        lastErr = err;
      }
    }
    throw lastErr instanceof AppError
      ? lastErr
      : new AppError("UPSTREAM_UNAVAILABLE", "All HiFi instances are unavailable", { provider: this.name, cause: lastErr });
  }

  async getTrackMetadata(id: string): Promise<ProviderTrack | null> {
    return this.metaCache.get(id) ?? null;
  }

  async getStreamUrl(id: string, options: StreamOptions = {}): Promise<StreamSource> {
    let lastErr: unknown;
    for (const base of this.pickOrder()) {
      const streamUrl = `${base}/track/${encodeURIComponent(id)}`;
      try {
        const res = await this.fetchFn(streamUrl, {
          method: "GET",
          headers: { range: "bytes=0-63" },
          signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        });
        if (res.status === 200 || res.status === 206) {
          const headBytes = new Uint8Array(await res.arrayBuffer());
          const check = verifyLosslessStream(res.headers.get("content-type"), headBytes);
          if (!check.ok) {
            this.markDown(base, this.cooldownMs);
            lastErr = new AppError("UPSTREAM_UNAVAILABLE", check.reason ?? "Lossy stream rejected", { provider: this.name });
            continue;
          }
          const rangeMatch = res.headers.get("content-range")?.match(/\/(\d+)\s*$/);
          const lenHdr = res.headers.get("content-length");
          const parsedLen = rangeMatch ? Number(rangeMatch[1]) : res.status === 200 && lenHdr ? Number(lenHdr) : undefined;
          const contentLength = parsedLen !== undefined && Number.isFinite(parsedLen) && parsedLen > 0 ? parsedLen : undefined;
          const flacInfo = parseFlacStreamInfo(headBytes);
          const cachedMeta = this.metaCache.get(id);
          if (cachedMeta) {
            this.metaCache.set(id, {
              ...cachedMeta,
              ...(check.codec ? { codec: check.codec } : {}),
              ...(flacInfo?.bitDepth ? { bitDepth: cachedMeta.bitDepth ?? flacInfo.bitDepth } : {}),
              ...(flacInfo?.sampleRate ? { sampleRate: cachedMeta.sampleRate ?? flacInfo.sampleRate } : {}),
              ...(contentLength !== undefined ? { fileSize: cachedMeta.fileSize ?? contentLength } : {}),
            });
          }
          this.openUntil.delete(base);
          return {
            url: streamUrl,
            mimeType: check.mimeType ?? "audio/flac",
            extension: check.extension ?? "flac",
            ...(check.codec ? { codec: check.codec } : {}),
            ...(flacInfo?.bitDepth ? { bitDepth: flacInfo.bitDepth } : {}),
            ...(flacInfo?.sampleRate ? { sampleRate: flacInfo.sampleRate } : {}),
            ...(contentLength !== undefined ? { contentLength } : {}),
          };
        }
        await res.body?.cancel().catch(() => undefined);
        if (res.status === 404) {
          throw new AppError("NOT_FOUND", "Track not found on HiFi pool", { upstreamStatus: 404, provider: this.name });
        }
        const retryAfterMs = res.status === 429 ? parseRetryAfterMs(res.headers, undefined, this.cooldownMs) : this.cooldownMs;
        this.markDown(base, retryAfterMs);
        lastErr = new AppError("UPSTREAM_UNAVAILABLE", `HiFi stream ${base} returned HTTP ${res.status}`, {
          upstreamStatus: res.status,
          provider: this.name,
          retryAfterMs,
        });
      } catch (err) {
        if (err instanceof AppError && err.code === "NOT_FOUND") throw err;
        if (options.signal?.aborted) throw err;
        this.markDown(base, this.cooldownMs);
        lastErr = err;
      }
    }
    throw lastErr instanceof AppError
      ? lastErr
      : new AppError("UPSTREAM_UNAVAILABLE", "All HiFi stream instances failed", { provider: this.name, cause: lastErr });
  }

  private pickOrder(): string[] {
    const start = this.rrIndex++ % this.instances.length;
    const rotated = [...this.instances.slice(start), ...this.instances.slice(0, start)];
    const t = this.now();
    const healthy = rotated.filter((u) => t >= (this.openUntil.get(u) ?? 0));
    const cooled = rotated.filter((u) => t < (this.openUntil.get(u) ?? 0));
    return [...healthy, ...cooled];
  }

  private markDown(base: string, ms: number): void {
    this.openUntil.set(base, this.now() + ms);
  }

  private mapTrack(raw: RawTracksItem): ProviderTrack | null {
    const id = raw.trackId ?? raw.id;
    if (!id || !raw.title) return null;
    const format = (raw.format ?? raw.codec)?.toLowerCase().replace(/^\./, "");
    const quality = raw.quality ?? raw.audioQuality;
    if (!inferLossless(format, quality, true)) return null;

    const artist =
      (Array.isArray(raw.artistNames) && raw.artistNames.length ? raw.artistNames.join(", ") : undefined) ??
      (Array.isArray(raw.artists) && raw.artists.length ? raw.artists.map((a) => a.name).filter(Boolean).join(", ") : undefined) ??
      (typeof raw.artist === "string" ? raw.artist : raw.artist?.name) ??
      "Unknown artist";
    const durMs =
      typeof raw.durationMs === "number" && raw.durationMs > 0
        ? Math.round(raw.durationMs)
        : typeof raw.duration === "number" && raw.duration > 0
          ? Math.round(raw.duration > 36_000 ? raw.duration : raw.duration * 1000)
          : undefined;
    const dur = durMs !== undefined ? Math.round(durMs / 1000) : undefined;
    const album = raw.album?.title ?? raw.album?.name ?? raw.albumTitle;
    const coverUrl = raw.artworkUrl ?? raw.coverUrl ?? raw.artwork ?? raw.cover ?? raw.album?.cover;
    const releaseStr = raw.releaseDate ?? raw.release_date ?? raw.album?.releaseDate;
    const yearMatch = releaseStr?.match(/^(\d{4})/);
    const year = raw.year ?? raw.album?.year ?? (yearMatch ? Number(yearMatch[1]) : undefined);
    const trackNumber = raw.trackNumber ?? raw.track_number;
    const bitDepth = raw.bitDepth ?? raw.bit_depth;
    const rawSr = raw.sampleRate ?? raw.sample_rate;
    const sampleRate = rawSr !== undefined ? (rawSr < 1000 ? Math.round(rawSr * 1000) : Math.round(rawSr)) : undefined;
    const fileSize = raw.fileSize ?? raw.file_size ?? raw.size;
    const track: ProviderTrack = {
      id: String(id),
      provider: this.name,
      title: raw.title,
      artist,
      ...(album ? { album } : {}),
      ...(year ? { year } : {}),
      ...(trackNumber ? { trackNumber } : {}),
      ...(dur !== undefined ? { durationSec: dur } : {}),
      ...(durMs !== undefined ? { durationMs: durMs } : {}),
      ...(coverUrl ? { coverUrl, artworkUrl: coverUrl } : {}),
      ...(bitDepth ? { bitDepth } : {}),
      ...(sampleRate ? { sampleRate } : {}),
      ...(raw.bitrateKbps ? { bitrateKbps: raw.bitrateKbps } : {}),
      ...(fileSize ? { fileSize } : {}),
      format: format ?? "flac",
      codec: format === "alac" || format === "m4a" ? "ALAC" : "FLAC",
      lossless: true,
      ...(raw.isrc ? { isrc: raw.isrc } : {}),
    };
    if (this.metaCache.size >= 500) {
      const oldest = this.metaCache.keys().next().value;
      if (oldest !== undefined) this.metaCache.delete(oldest);
    }
    this.metaCache.set(track.id, track);
    return track;
  }
}
