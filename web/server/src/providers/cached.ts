import { SingleFlight } from "../lib/concurrency.js";
import type { CacheStore } from "../lib/cache.js";
import { normalizeText } from "../lib/text.js";
import type { AudioProvider, ProviderTrack, SearchOptions, StreamOptions, StreamSource } from "./types.js";

export interface CacheTtls {
  searchMs: number;
  streamUrlMs: number;
  trackMs: number;
}

/** Signed URLs are dropped this long before they expire so playback never starts on a dying link. */
export const URL_EXPIRY_SAFETY_MS = 60_000;

/**
 * Caching decorator around one concrete provider:
 * - search results: `searchMs` (15 min); every hit also seeds the track cache
 * - track metadata: `trackMs` (6 h)
 * - resolved stream URLs: `streamUrlMs` (6 h), capped by the URL's own expiry,
 *   with single-flight so concurrent plays of one track trigger one job.
 */
export class CachedProvider implements AudioProvider {
  readonly name: string;
  readonly kind: string;
  private readonly flights = new SingleFlight<StreamSource>();

  constructor(
    readonly inner: AudioProvider,
    private readonly cache: CacheStore,
    private readonly ttl: CacheTtls,
    private readonly now: () => number = Date.now,
  ) {
    this.name = inner.name;
    this.kind = inner.kind;
  }

  async search(query: string, options: SearchOptions = {}): Promise<ProviderTrack[]> {
    return (await this.searchWithMeta(query, options)).tracks;
  }

  async searchWithMeta(query: string, options: SearchOptions = {}): Promise<{ tracks: ProviderTrack[]; cached: boolean }> {
    const key = `search:${this.name}:${options.limit ?? "d"}:${normalizeText(query)}`;
    const hit = await this.cache.get<ProviderTrack[]>(key);
    if (hit) return { tracks: hit, cached: true };

    const tracks = await this.inner.search(query, options);
    await this.cache.set(key, tracks, this.ttl.searchMs);
    await Promise.all(tracks.map((t) => this.cache.set(this.trackKey(t.id), t, this.ttl.trackMs)));
    return { tracks, cached: false };
  }

  /** Cache-only lookup — never touches the network. */
  peekTrack(id: string): Promise<ProviderTrack | undefined> {
    return this.cache.get<ProviderTrack>(this.trackKey(id));
  }

  async getTrackMetadata(id: string): Promise<ProviderTrack | null> {
    const hit = await this.peekTrack(id);
    if (hit) return hit;
    const track = await this.inner.getTrackMetadata(id);
    if (track) await this.cache.set(this.trackKey(id), track, this.ttl.trackMs);
    return track;
  }

  async getStreamUrl(id: string, options: StreamOptions = {}): Promise<StreamSource> {
    const key = this.urlKey(id);
    const hit = await this.cache.get<StreamSource>(key);
    if (hit && this.stillValid(hit)) return hit;

    return this.flights.run(key, async () => {
      const source = await this.inner.getStreamUrl(id, options);
      const ttl = this.ttlFor(source);
      if (ttl > 0) await this.cache.set(key, source, ttl);
      return source;
    });
  }

  isResolving(id: string): boolean {
    return this.flights.has(this.urlKey(id));
  }

  async invalidateStream(id: string): Promise<void> {
    await this.cache.delete(this.urlKey(id));
  }

  getCoverSource(coverId: string): Promise<StreamSource> {
    if (!this.inner.getCoverSource) return Promise.reject(new Error("no cover proxy"));
    return this.inner.getCoverSource(coverId);
  }

  get hasCoverProxy(): boolean {
    return typeof this.inner.getCoverSource === "function";
  }

  async authorizeStream(source: StreamSource): Promise<Record<string, string>> {
    return this.inner.authorizeStream ? this.inner.authorizeStream(source) : {};
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }

  private stillValid(source: StreamSource): boolean {
    return source.expiresAt === undefined || source.expiresAt - URL_EXPIRY_SAFETY_MS > this.now();
  }

  private ttlFor(source: StreamSource): number {
    if (source.expiresAt === undefined) return this.ttl.streamUrlMs;
    return Math.min(this.ttl.streamUrlMs, source.expiresAt - URL_EXPIRY_SAFETY_MS - this.now());
  }

  private trackKey(id: string): string {
    return `track:${this.name}:${id}`;
  }

  private urlKey(id: string): string {
    return `url:${this.name}:${id}`;
  }
}
