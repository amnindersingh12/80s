import type { ProviderHealth, Track } from "../../../shared/api.js";
import { AppError, isFailoverEligible } from "../errors.js";
import { bestMatch } from "../lib/text.js";
import type { CachedProvider } from "./cached.js";
import { normalizeLosslessMetadata, type ProviderTrack, type StreamOptions, type StreamSource } from "./types.js";

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
  const normalized = normalizeLosslessMetadata(t);
  return { ...normalized, id: publicId(t.provider, t.id) };
}

/**
 * Routes public `<provider>:<id>` ids to the owning provider and fails over
 * from the primary to the optional fallback when the primary times out or is
 * unavailable. A simple circuit breaker keeps routing around the primary for
 * `cooldownMs` after a failure so every request does not pay the timeout again.
 */
export class ProviderChain {
  readonly providers: CachedProvider[];
  readonly primary: CachedProvider;
  readonly fallback?: CachedProvider;
  private readonly openUntil = new Map<string, number>();
  private readonly lastErrors = new Map<string, string>();
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(
    primaryOrList: CachedProvider | CachedProvider[],
    fallbackOrOptions?: CachedProvider | ProviderChainOptions,
    private readonly options: ProviderChainOptions = {},
  ) {
    if (Array.isArray(primaryOrList)) {
      if (primaryOrList.length === 0) throw new Error("ProviderChain requires at least one provider");
      this.providers = primaryOrList;
      this.options = (fallbackOrOptions as ProviderChainOptions | undefined) ?? {};
    } else {
      this.providers = fallbackOrOptions && "searchWithMeta" in fallbackOrOptions
        ? [primaryOrList, fallbackOrOptions]
        : [primaryOrList];
      if (fallbackOrOptions && !("searchWithMeta" in fallbackOrOptions)) {
        this.options = fallbackOrOptions;
      }
    }
    this.primary = this.providers[0]!;
    this.fallback = this.providers[1];
    this.cooldownMs = this.options.cooldownMs ?? 30_000;
    this.now = this.options.now ?? Date.now;
    const names = new Set(this.providers.map((p) => p.name));
    if (names.size !== this.providers.length) throw new Error("Providers in chain need distinct names");
  }

  get circuitOpen(): boolean {
    return this.providers.length > 1 && this.isOpen(this.primary.name);
  }

  private isOpen(name: string): boolean {
    return this.now() < (this.openUntil.get(name) ?? 0);
  }

  get(name: string): CachedProvider | undefined {
    return this.providers.find((p) => p.name === name);
  }

  async search(query: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<ChainSearchResult> {
    const order = this.order();
    let lastErr: unknown;
    for (const [i, p] of order.entries()) {
      try {
        const { tracks, cached } = await p.searchWithMeta(query, options);
        this.recordSuccess(p.name);
        return { tracks: tracks.filter((t) => t.lossless).map(toPublic), provider: p.name, fallback: p !== this.primary, cached };
      } catch (err) {
        lastErr = err;
        if (!isFailoverEligible(err)) throw err;
        this.recordFailure(p.name, err);
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
    const others = this.order().filter((other) => other !== p);

    if (others.length === 0) {
      return { source: await p.getStreamUrl(rawId, options), servedBy: p, servedId: rawId, fallback: false };
    }

    if (this.isOpen(p.name)) {
      const viaFallback = await this.tryFallbacksFor(p, rawId, others, options);
      if (viaFallback) return viaFallback;
    }

    try {
      const source = await p.getStreamUrl(rawId, options);
      this.recordSuccess(p.name);
      return { source, servedBy: p, servedId: rawId, fallback: false };
    } catch (err) {
      if (!isFailoverEligible(err)) throw err;
      this.recordFailure(p.name, err);
      const viaFallback = await this.tryFallbacksFor(p, rawId, others, options);
      if (!viaFallback) throw err;
      this.options.onFailover?.({ op: "stream", from: p.name, to: viaFallback.servedBy.name, error: err as AppError });
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
    return this.providers.map((p, i) => {
      const err = this.lastErrors.get(p.name);
      return {
        name: p.name,
        kind: p.kind,
        role: i === 0 ? "primary" : "fallback",
        circuit: this.isOpen(p.name) ? "open" : "closed",
        ...(err ? { lastError: err } : {}),
      };
    });
  }

  async close(): Promise<void> {
    await Promise.all(this.providers.map((p) => p.close()));
  }

  /** Finds the same recording on the next healthy provider using cached metadata. */
  private async tryFallbacksFor(
    owner: CachedProvider,
    rawId: string,
    candidates: CachedProvider[],
    options: StreamOptions,
  ): Promise<ResolvedStream | undefined> {
    const meta = (await owner.peekTrack(rawId)) ?? (this.isOpen(owner.name) ? undefined : await owner.getTrackMetadata(rawId).catch(() => null));
    if (!meta) return undefined;

    for (const fb of candidates) {
      try {
        const { tracks } = await fb.searchWithMeta(`${meta.artist} ${meta.title}`, { limit: 10 });
        const match = bestMatch(meta, tracks);
        if (!match) continue;
        const source = await fb.getStreamUrl(match.candidate.id, options);
        this.recordSuccess(fb.name);
        return { source, servedBy: fb, servedId: match.candidate.id, fallback: true };
      } catch (err) {
        if (isFailoverEligible(err)) this.recordFailure(fb.name, err);
      }
    }
    return undefined;
  }

  private order(): CachedProvider[] {
    const healthy = this.providers.filter((p) => !this.isOpen(p.name));
    const cooled = this.providers.filter((p) => this.isOpen(p.name));
    return [...healthy, ...cooled];
  }

  private require(name: string): CachedProvider {
    const p = this.get(name);
    if (!p) throw new AppError("NOT_FOUND", `Unknown provider "${name}"`);
    return p;
  }

  private recordFailure(name: string, err: unknown): void {
    this.lastErrors.set(name, err instanceof Error ? err.message : String(err));
    const retryMs = err instanceof AppError && err.retryAfterMs ? err.retryAfterMs : this.cooldownMs;
    if (this.providers.length > 1 && retryMs > 0) this.openUntil.set(name, this.now() + retryMs);
  }

  private recordSuccess(name: string): void {
    this.openUntil.delete(name);
    this.lastErrors.delete(name);
  }
}
