import { AppError } from "../errors.js";
import { parseRetryAfterMs, requestJson, type FetchFn } from "../lib/http.js";
import { verifyLosslessStream, type AudioProvider, type ProviderTrack, type SearchOptions, type StreamOptions, type StreamSource } from "./types.js";

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
  album?: { title?: string; cover?: string };
  albumTitle?: string;
  artwork?: string;
  duration?: number;
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
          const contentLength = rangeMatch ? Number(rangeMatch[1]) : undefined;
          this.openUntil.delete(base);
          return {
            url: streamUrl,
            mimeType: check.mimeType ?? "audio/flac",
            extension: check.extension ?? "flac",
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
    const artist =
      (Array.isArray(raw.artistNames) && raw.artistNames.length ? raw.artistNames.join(", ") : undefined) ??
      (Array.isArray(raw.artists) && raw.artists.length ? raw.artists.map((a) => a.name).filter(Boolean).join(", ") : undefined) ??
      (typeof raw.artist === "string" ? raw.artist : raw.artist?.name) ??
      "Unknown artist";
    const dur = typeof raw.duration === "number" ? (raw.duration > 36_000 ? Math.round(raw.duration / 1000) : Math.round(raw.duration)) : undefined;
    const track: ProviderTrack = {
      id: String(id),
      provider: this.name,
      title: raw.title,
      artist,
      ...(raw.album?.title || raw.albumTitle ? { album: raw.album?.title ?? raw.albumTitle } : {}),
      ...(dur !== undefined ? { durationSec: dur } : {}),
      ...(raw.artwork ? { coverUrl: raw.artwork } : {}),
      format: "flac",
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
