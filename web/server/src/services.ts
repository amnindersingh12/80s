import { LoginAuth } from "./auth/login.js";
import { NoAuth, StaticBearer } from "./auth/static.js";
import { SupabaseAuth } from "./auth/supabase.js";
import type { Config } from "./config.js";
import { createCache, type CacheStore } from "./lib/cache.js";
import { joinUrl, type FetchFn } from "./lib/http.js";
import { CachedProvider } from "./providers/cached.js";
import { ProviderChain } from "./providers/chain.js";
import { HiFiPoolProvider } from "./providers/hifi.js";
import { MockAudioProvider } from "./providers/mock.js";
import { RemoteMediaProvider, type TokenSource } from "./providers/remote.js";
import { SubsonicProvider } from "./providers/subsonic.js";
import type { AudioProvider } from "./providers/types.js";
import { LastfmClient } from "./recommendations/lastfm.js";
import { ListenBrainzClient } from "./recommendations/listenbrainz.js";
import { MusicBrainzClient } from "./recommendations/musicbrainz.js";
import { RecommendationEngine } from "./recommendations/engine.js";
import { withDemoAudio } from "./services/demo.js";
import { PrepareTracker } from "./services/prepare.js";

export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface AppServices {
  chain: ProviderChain;
  tracker: PrepareTracker;
  engine: RecommendationEngine;
  cache: CacheStore;
  /** fetch used for audio/cover pass-through (knows the demo:// scheme in demo mode). */
  streamFetch: FetchFn;
  /** Header timeout for audio/cover upstream requests. */
  streamTimeoutMs: number;
  demo?: MockAudioProvider;
  close(): Promise<void>;
}

export interface ServiceOverrides {
  fetch?: FetchFn;
  cache?: CacheStore;
  primary?: AudioProvider;
  fallback?: AudioProvider;
  logger?: Logger;
  now?: () => number;
}

/** Wires providers, caches and the recommendation engine from a `Config`. */
export async function createServices(config: Config, overrides: ServiceOverrides = {}): Promise<AppServices> {
  const fetchFn = overrides.fetch ?? fetch;
  const log = overrides.logger;
  const cache =
    overrides.cache ??
    (await createCache({
      redisUrl: config.redisUrl,
      prefix: config.cachePrefix,
      maxEntries: config.memoryCacheMaxEntries,
      onError: (err) => log?.warn({ err }, "cache error (continuing without cache)"),
    }));

  let demo: MockAudioProvider | undefined;
  let primary = overrides.primary;
  let fallback = overrides.fallback;
  let auth: TokenSource | undefined;

  if (!primary) {
    if (config.demo) {
      demo = new MockAudioProvider({ name: "demo", streamUrl: (id) => `demo://audio/${encodeURIComponent(id)}` });
      primary = demo;
    } else if (config.remote) {
      const r = config.remote;
      auth =
        r.authMode === "supabase"
          ? new SupabaseAuth({
              ...r.supabase,
              fetch: fetchFn,
              onError: (err) => log?.warn({ err: describe(err) }, "media server token refresh failed"),
            })
          : r.authMode === "login"
            ? new LoginAuth({
                loginUrl: joinUrl(r.baseUrl, r.loginPath),
                email: r.supabase.email ?? "",
                password: r.supabase.password ?? "",
                refreshMarginMs: r.supabase.refreshMarginMs,
                timeoutMs: r.requestTimeoutMs,
                fetch: fetchFn,
              })
            : r.authMode === "bearer"
              ? new StaticBearer(r.bearerToken ?? "")
              : new NoAuth();
      primary = new RemoteMediaProvider({ config: config.remote, auth, fetch: fetchFn });
    } else if (config.subsonic) {
      primary = new SubsonicProvider(config.subsonic, { fetch: fetchFn });
    } else if (!config.hifi) {
      throw new Error("No provider configured: set MEDIA_API_BASE, HIFI_API_INSTANCES, SUBSONIC_URL or DEMO_MODE=true");
    }
  }
  if (!fallback && config.subsonic && primary?.kind !== "opensubsonic" && !config.demo) {
    fallback = new SubsonicProvider(config.subsonic, { fetch: fetchFn });
  }

  const ttl = config.cacheTtl;
  let providers: CachedProvider[];
  if (overrides.primary) {
    providers = [new CachedProvider(overrides.primary, cache, ttl, overrides.now)];
    if (fallback) providers.push(new CachedProvider(fallback, cache, ttl, overrides.now));
  } else if (config.demo) {
    providers = [new CachedProvider(primary!, cache, ttl, overrides.now)];
  } else {
    const byName = new Map<string, AudioProvider>();
    if (config.hifi) byName.set("hifi", new HiFiPoolProvider({ ...config.hifi, fetch: fetchFn, now: overrides.now }));
    if (primary) byName.set(primary.name, primary);
    if (fallback) byName.set(fallback.name, fallback);
    const ordered: AudioProvider[] = [];
    for (const name of config.providerOrder) {
      const p = byName.get(name);
      if (p) {
        ordered.push(p);
        byName.delete(name);
      }
    }
    for (const p of byName.values()) ordered.push(p);
    providers = ordered.map((p) => new CachedProvider(p, cache, ttl, overrides.now));
  }

  const chain = new ProviderChain(
    providers,
    {
      cooldownMs: config.fallbackCooldownMs,
      now: overrides.now,
      onFailover: ({ op, from, to, error }) => log?.warn({ op, from, to, code: error.code }, `failover: ${from} → ${to}`),
    },
  );
  const tracker = new PrepareTracker(chain, { now: overrides.now });

  const rc = config.recommendations;
  const engine = new RecommendationEngine({
    chain,
    cache,
    cacheTtlMs: rc.cacheTtlMs,
    matchConcurrency: rc.matchConcurrency,
    maxMatchLookups: rc.maxMatchLookups,
    lastfm: rc.lastfm ? new LastfmClient({ ...rc.lastfm, timeoutMs: rc.timeoutMs, fetch: fetchFn }) : undefined,
    listenbrainz: rc.listenbrainz ? new ListenBrainzClient({ ...rc.listenbrainz, timeoutMs: rc.timeoutMs, fetch: fetchFn }) : undefined,
    musicbrainz: rc.musicbrainz ? new MusicBrainzClient({ ...rc.musicbrainz, timeoutMs: rc.timeoutMs, fetch: fetchFn }) : undefined,
    log: (msg, err) => log?.warn({ err: describe(err) }, msg),
  });

  return {
    chain,
    tracker,
    engine,
    cache,
    demo,
    streamFetch: demo ? withDemoAudio(fetchFn, demo) : fetchFn,
    streamTimeoutMs: config.remote?.requestTimeoutMs ?? config.subsonic?.timeoutMs ?? 15_000,
    async close() {
      auth?.close?.();
      await chain.close();
      await cache.close();
    },
  };
}

/** Error summary safe for logs (no stack spam, no request details). */
function describe(err: unknown): unknown {
  if (err instanceof Error) return { name: err.name, message: err.message, code: (err as { code?: string }).code };
  return err;
}
