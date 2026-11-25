import type { ProviderHealth, Track } from "../../../shared/api.js";
import { AppError, isFailoverEligible } from "../errors.js";
import { bestMatch } from "../lib/text.js";
import type { CachedProvider } from "./cached.js";
import type { ProviderTrack, StreamOptions, StreamSource } from "./types.js";

export interface ResolvedStream {
  source: StreamSource;
  /** Provider that produced `source` (may be the fallback). */
  servedBy: CachedProvider;
  /** Provider-local id on `servedBy`. */
  servedId: string;
  fallback: boolean;
}

export interface ChainSearchResult {
  tracks: Track[];
  provider: string;
  fallback: boolean;
  cached: boolean;
}

export interface ProviderChainOptions {
  /** How long to route around the primary after it times out / goes down. */
  cooldownMs?: number;
  now?: () => number;
  onFailover?: (info: { op: string; from: string; to: string; error: AppError }) => void;
}

export function publicId(provider: string, rawId: string): string {
  return `${provider}:${rawId}`;
}

export function parsePublicId(id: string): { provider: string; rawId: string } {
  const i = id.indexOf(":");
  if (i <= 0 || i === id.length - 1 || id.length > 512) {
    throw new AppError("BAD_REQUEST", "Malformed track id; expected <provider>:<id>");
  }
  return { provider: id.slice(0, i), rawId: id.slice(i + 1) };
}

function toPublic(t: ProviderTrack): Track {
  return { ...t, id: publicId(t.provider, t.id) };
}

/**
 * Routes public `<provider>:<id>` ids to the owning provider and fails over
 * from the primary to the optional fallback when the primary times out or is
 * unavailable. A simple circuit breaker keeps routing around the primary for
 * `cooldownMs` after a failure so every request does not pay the timeout again.
 */
export class ProviderChain {
  private openUntil = 0;
  private lastError: string | undefined;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(
    readonly primary: CachedProvider,
    readonly fallback?: CachedProvider,
    private readonly options: ProviderChainOptions = {},
  ) {
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
    if (fallback && fallback.name === primary.name) throw new Error("Primary and fallback providers need distinct names");
  }

  get circuitOpen(): boolean {
    return this.fallback !== undefined && this.now() < this.openUntil;
  }

  get(name: string): CachedProvider | undefined {
    if (name === this.primary.name) return this.primary;
    if (this.fallback && name === this.fallback.name) return this.fallback;
    return undefined;
  }

  async search(query: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<ChainSearchResult> {
    const order = this.order();
    let lastErr: unknown;
    for (const [i, p] of order.entries()) {
      try {
        const { tracks, cached } = await p.searchWithMeta(query, options);
        if (p === this.primary) this.recordSuccess();
        return { tracks: tracks.map(toPublic), provider: p.name, fallback: p !== this.primary, cached };
      } catch (err) {
        lastErr = err;
        if (!isFailoverEligible(err)) throw err;
        if (p === this.primary) this.recordFailure(err);
        const next = order[i + 1];
        if (next) this.options.onFailover?.({ op: "search", from: p.name, to: next.name, error: err as AppError });
      }
    }
    throw lastErr;
  }

  async getTrack(id: string): Promise<Track | null> {
    const { provider, rawId } = parsePublicId(id);
    const p = this.require(provider);
    const t = await p.getTrackMetadata(rawId);
    return t ? toPublic(t) : null;
  }

  async resolveStream(id: string, options: StreamOptions = {}): Promise<ResolvedStream> {
    const { provider, rawId } = parsePublicId(id);
    const p = this.require(provider);
    const fb = this.fallback;

    if (p !== this.primary || !fb) {
      return { source: await p.getStreamUrl(rawId, options), servedBy: p, servedId: rawId, fallback: false };
    }

    if (this.circuitOpen) {
      const viaFallback = await this.tryFallbackFor(rawId, options).catch(() => undefined);
      if (viaFallback) return viaFallback;
    }

    try {
      const source = await p.getStreamUrl(rawId, options);
      this.recordSuccess();
      return { source, servedBy: p, servedId: rawId, fallback: false };
    } catch (err) {
      if (!isFailoverEligible(err)) throw err;
      this.recordFailure(err);
      const viaFallback = await this.tryFallbackFor(rawId, options).catch(() => undefined);
      if (!viaFallback) throw err;
      this.options.onFailover?.({ op: "stream", from: p.name, to: fb.name, error: err as AppError });
      return viaFallback;
    }
  }

  async invalidateStream(resolved: Pick<ResolvedStream, "servedBy" | "servedId">): Promise<void> {
    await resolved.servedBy.invalidateStream(resolved.servedId);
  }

  async coverSource(id: string): Promise<{ source: StreamSource; provider: CachedProvider }> {
    const { provider, rawId } = parsePublicId(id);
    const p = this.require(provider);
    if (!p.hasCoverProxy) throw new AppError("NOT_FOUND", "This provider serves covers directly");
    return { source: await p.getCoverSource(rawId), provider: p };
  }

  health(): ProviderHealth[] {
    const out: ProviderHealth[] = [
      {
        name: this.primary.name,
        kind: this.primary.kind,
        role: "primary",
        circuit: this.circuitOpen ? "open" : "closed",
        ...(this.lastError ? { lastError: this.lastError } : {}),
      },
    ];
    if (this.fallback) out.push({ name: this.fallback.name, kind: this.fallback.kind, role: "fallback", circuit: "closed" });
    return out;
  }

  async close(): Promise<void> {
    await this.primary.close();
    await this.fallback?.close();
  }

  /** Finds the same recording on the fallback provider using cached primary metadata. */
  private async tryFallbackFor(rawId: string, options: StreamOptions): Promise<ResolvedStream | undefined> {
    const fb = this.fallback;
    if (!fb) return undefined;
    const meta = (await this.primary.peekTrack(rawId)) ?? (this.circuitOpen ? undefined : await this.primary.getTrackMetadata(rawId).catch(() => null));
    if (!meta) return undefined;

    const { tracks } = await fb.searchWithMeta(`${meta.artist} ${meta.title}`, { limit: 10 });
    const match = bestMatch(meta, tracks);
    if (!match) return undefined;
    const source = await fb.getStreamUrl(match.candidate.id, options);
    return { source, servedBy: fb, servedId: match.candidate.id, fallback: true };
  }

  private order(): CachedProvider[] {
    if (!this.fallback) return [this.primary];
    return this.circuitOpen ? [this.fallback, this.primary] : [this.primary, this.fallback];
  }

  private require(name: string): CachedProvider {
    const p = this.get(name);
    if (!p) throw new AppError("NOT_FOUND", `Unknown provider "${name}"`);
    return p;
  }

  private recordFailure(err: unknown): void {
    this.lastError = err instanceof Error ? err.message : String(err);
    if (this.fallback && this.cooldownMs > 0) this.openUntil = this.now() + this.cooldownMs;
  }

  private recordSuccess(): void {
    this.openUntil = 0;
    this.lastError = undefined;
  }
}
