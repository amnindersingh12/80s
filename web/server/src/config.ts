/**
 * All runtime configuration comes from environment variables (see
 * `.env.example` / README). This module is the only place that reads
 * `process.env`; everything else receives a typed `Config`.
 */

export type Env = Record<string, string | undefined>;

export interface TrackFieldMap {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  durationSec: string;
  durationMs: string;
  coverUrl: string;
  format: string;
  quality: string;
  bitDepth: string;
  sampleRate: string;
  bitrateKbps: string;
  year: string;
  trackNumber: string;
  isrc: string;
}

export interface JobFieldMap {
  jobId: string;
  status: string;
  url: string;
  progress: string;
  stage: string;
  error: string;
  expiresAt: string;
}

export type MediaAuthMode = "none" | "bearer" | "supabase" | "login";

export interface SupabaseConfig {
  url: string;
  anonKey: string;
  email?: string;
  password?: string;
  refreshToken?: string;
  refreshMarginMs: number;
  timeoutMs: number;
}

export interface RemoteProviderConfig {
  baseUrl: string;
  searchPath: string;
  searchParam: string;
  searchLimitParam?: string;
  searchExtraParams: Record<string, string>;
  searchResultsPath: string;
  trackPath?: string;
  jobCreatePath: string;
  jobCreateMethod: "POST" | "PUT" | "GET";
  trackIdField: string;
  jobExtraBody: Record<string, unknown>;
  jobStatusPath: string;
  trackFields: TrackFieldMap;
  jobFields: JobFieldMap;
  jobSuccessStates: string[];
  jobFailureStates: string[];
  requestTimeoutMs: number;
  pollIntervalMs: number;
  maxJobWaitMs: number;
  jobRetries: number;
  jobConcurrency: number;
  jobQueueTimeoutMs: number;
  searchMaxPerMin: number;
  streamAuth: "auto" | "always" | "never";
  /**
   * How requests to the media server authenticate (MEDIA_AUTH_MODE, `auto` already resolved):
   * - `none`: no auth header (guest / public endpoints)
   * - `bearer`: static `Authorization: Bearer MEDIA_BEARER_TOKEN`
   * - `supabase`: Supabase password/refresh grants (the `supabase` block below)
   */
  authMode: MediaAuthMode;
  /** What MEDIA_AUTH_MODE said (`auto` resolves to `supabase` or `none`). */
  authModeSetting: MediaAuthMode | "auto";
  bearerToken?: string;
  /** Only used when `authMode` is `supabase`. */
  supabase: SupabaseConfig;
  /** Only used when `authMode` is `login`. */
  loginPath: string;
}

export interface SubsonicConfig {
  baseUrl: string;
  user?: string;
  password?: string;
  apiKey?: string;
  client: string;
  timeoutMs: number;
}

export interface RecommendationConfig {
  lastfm?: { apiKey: string; baseUrl: string };
  listenbrainz?: { baseUrl: string; labsBaseUrl: string; similarAlgorithm?: string; token?: string };
  musicbrainz?: { baseUrl: string; userAgent: string };
  timeoutMs: number;
  matchConcurrency: number;
  maxMatchLookups: number;
  cacheTtlMs: number;
}

export interface HiFiConfig {
  instances: string[];
  timeoutMs: number;
  cooldownMs: number;
}

export interface Config {
  host: string;
  port: number;
  logLevel: string;
  trustProxy: boolean;
  accessKey?: string;
  clientDistDir?: string;
  redisUrl?: string;
  cachePrefix: string;
  /** LRU cap of the in-memory cache when REDIS_URL is unset (keeps a 512 MiB dyno safe). */
  memoryCacheMaxEntries: number;
  /** MEDIA_FRONTEND_URL: page scanned at startup to fill blank SUPABASE_* / MEDIA_API_BASE. */
  frontendUrl?: string;
  demo: boolean;
  providerOrder: string[];
  hifi?: HiFiConfig;
  remote?: RemoteProviderConfig;
  subsonic?: SubsonicConfig;
  fallbackCooldownMs: number;
  cacheTtl: { searchMs: number; streamUrlMs: number; trackMs: number };
  recommendations: RecommendationConfig;
}

export const DEFAULT_TRACK_FIELDS: TrackFieldMap = {
  id: "id|trackId|track_id|uuid",
  title: "title|name|trackName|track_name",
  artist: "artist.name|artists|artist|artistName|artist_name|performer.name",
  album: "album.title|album.name|album|albumName|album_name",
  albumArtist: "album.artist.name|albumArtist|album_artist|performer.name",
  durationSec: "duration|durationSec|duration_seconds|length",
  durationMs: "durationMs|duration_ms",
  coverUrl: "coverUrl|cover_url|cover|artwork|artworkUrl|image|thumbnail|album.coverUrl|album.cover|album.image.large|album.image.small|album.image",
  format: "format|codec|container|extension|suffix",
  quality: "quality|audioQuality|audio_quality",
  bitDepth: "bitDepth|bit_depth|maximum_bit_depth|maximumBitDepth|mediaMetadata.bitDepth",
  sampleRate: "sampleRate|sample_rate|samplingRate|maximum_sampling_rate|maximumSamplingRate",
  bitrateKbps: "bitrate|bitRate|bitrateKbps",
  year: "year|releaseYear|album.year",
  trackNumber: "trackNumber|track_number|number|position",
  isrc: "isrc",
};

export const DEFAULT_JOB_FIELDS: JobFieldMap = {
  jobId: "jobId|job_id|job.id|id",
  status: "status|state|job.status|job.state",
  url: "url|downloadUrl|download_url|signedUrl|signed_url|fileUrl|file_url|result.url|result.downloadUrl|job.url|job.result.url",
  progress: "progress|percent|percentage|job.progress",
  stage: "stage|step|phase|job.stage",
  error: "error.message|error|failureReason|reason|job.error",
  expiresAt: "expiresAt|expires_at|urlExpiresAt|result.expiresAt|job.expiresAt",
};

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

class Reader {
  readonly problems: string[] = [];
  constructor(private readonly env: Env) {}

  str(name: string): string | undefined {
    const v = this.env[name];
    if (v === undefined) return undefined;
    const t = v.trim();
    return t === "" ? undefined : t;
  }

  def(name: string, fallback: string): string {
    return this.str(name) ?? fallback;
  }

  int(name: string, fallback: number, min = 0): number {
    const raw = this.str(name);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) {
      this.problems.push(`${name} must be an integer >= ${min} (got "${raw}")`);
      return fallback;
    }
    return n;
  }

  bool(name: string, fallback: boolean): boolean {
    const raw = this.str(name)?.toLowerCase();
    if (raw === undefined) return fallback;
    if (["1", "true", "yes", "on"].includes(raw)) return true;
    if (["0", "false", "no", "off"].includes(raw)) return false;
    this.problems.push(`${name} must be true/false (got "${raw}")`);
    return fallback;
  }

  url(name: string): string | undefined {
    const raw = this.str(name);
    if (raw === undefined) return undefined;
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("protocol");
      return raw.replace(/\/+$/, "");
    } catch {
      this.problems.push(`${name} must be an absolute http(s) URL (got "${raw}")`);
      return undefined;
    }
  }

  path(name: string, fallback: string): string {
    const v = this.def(name, fallback);
    return v.startsWith("/") || /^https?:\/\//.test(v) ? v : `/${v}`;
  }

  json<T extends object>(name: string): Partial<T> {
    const raw = this.str(name);
    if (raw === undefined) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      return parsed as Partial<T>;
    } catch {
      this.problems.push(`${name} must be a JSON object (got "${raw.slice(0, 80)}")`);
      return {};
    }
  }

  list(name: string, fallback: string[]): string[] {
    const raw = this.str(name);
    if (raw === undefined) return fallback;
    return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  }

  query(name: string): Record<string, string> {
    const raw = this.str(name);
    if (raw === undefined) return {};
    return Object.fromEntries(new URLSearchParams(raw.replace(/^\?/, "")));
  }

  oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const raw = this.str(name);
    if (raw === undefined) return fallback;
    const v = (allowed as readonly string[]).find((a) => a.toLowerCase() === raw.toLowerCase());
    if (!v) {
      this.problems.push(`${name} must be one of ${allowed.join(", ")} (got "${raw}")`);
      return fallback;
    }
    return v as T;
  }
}

function mergeFieldMap<T extends object>(defaults: T, overrides: Partial<T>, name: string, problems: string[]): T {
  const out = { ...defaults };
  for (const [k, v] of Object.entries(overrides)) {
    if (!(k in defaults)) {
      problems.push(`${name}: unknown field "${k}" (allowed: ${Object.keys(defaults).join(", ")})`);
      continue;
    }
    if (typeof v !== "string" || v.trim() === "") {
      problems.push(`${name}: field "${k}" must be a non-empty string`);
      continue;
    }
    (out as Record<string, string>)[k] = v;
  }
  return out;
}

export function loadConfig(env: Env = process.env): Config {
  const r = new Reader(env);

  const requestTimeoutMs = r.int("MEDIA_REQUEST_TIMEOUT_MS", 15_000, 1);
  const baseUrl = r.url("MEDIA_API_BASE");

  let remote: RemoteProviderConfig | undefined;
  let authMode: MediaAuthMode | undefined;
  let authModeSetting: MediaAuthMode | "auto" | undefined;
  const frontendUrl = r.url("MEDIA_FRONTEND_URL");
  if (baseUrl) {
    const supabaseUrl = r.url("SUPABASE_URL");
    const anonKey = r.str("SUPABASE_ANON_KEY");
    const email = r.str("MEDIA_USER_EMAIL");
    const password = r.str("MEDIA_USER_PASSWORD");
    const refreshToken = r.str("MEDIA_REFRESH_TOKEN");
    const bearerToken = r.str("MEDIA_BEARER_TOKEN");
    authModeSetting = r.oneOf("MEDIA_AUTH_MODE", ["auto", "none", "bearer", "supabase", "login"] as const, "auto");
    // auto: log in with Supabase when login credentials exist, otherwise guest (no auth).
    const hasLogin = Boolean(refreshToken || (email && password));
    authMode = authModeSetting === "auto" ? (hasLogin ? "supabase" : "none") : authModeSetting;
    if (authMode === "supabase") {
      const why = authModeSetting === "auto" ? "for the Supabase login (MEDIA_USER_* / MEDIA_REFRESH_TOKEN are set)" : "when MEDIA_AUTH_MODE=supabase";
      const hint = frontendUrl ? " — MEDIA_FRONTEND_URL discovery didn't find it" : " (or set MEDIA_FRONTEND_URL to discover it)";
      if (!supabaseUrl) r.problems.push(`SUPABASE_URL is required ${why}${hint}`);
      if (!anonKey) r.problems.push(`SUPABASE_ANON_KEY is required ${why}${hint}`);
      if (!refreshToken && !(email && password)) {
        r.problems.push("MEDIA_AUTH_MODE=supabase needs MEDIA_USER_EMAIL + MEDIA_USER_PASSWORD (and/or MEDIA_REFRESH_TOKEN)");
      }
    }
    if (authMode === "login" && !(email && password)) {
      r.problems.push("MEDIA_AUTH_MODE=login needs MEDIA_USER_EMAIL + MEDIA_USER_PASSWORD");
    }
    if (authMode === "bearer" && !bearerToken) r.problems.push("MEDIA_BEARER_TOKEN is required when MEDIA_AUTH_MODE=bearer");
    const method = r.oneOf("MEDIA_JOB_CREATE_METHOD", ["POST", "PUT", "GET"] as const, "POST");

    remote = {
      baseUrl,
      searchPath: r.path("MEDIA_SEARCH_PATH", "/api/search"),
      searchParam: r.def("MEDIA_SEARCH_PARAM", "q"),
      searchLimitParam: r.str("MEDIA_SEARCH_LIMIT_PARAM"),
      searchExtraParams: r.query("MEDIA_SEARCH_EXTRA_PARAMS"),
      searchResultsPath: r.def(
        "MEDIA_SEARCH_RESULTS_PATH",
        "results|tracks|items|data.results|data.tracks|data.items|data",
      ),
      trackPath: r.str("MEDIA_TRACK_PATH") ? r.path("MEDIA_TRACK_PATH", "") : undefined,
      jobCreatePath: r.path("MEDIA_JOB_CREATE_PATH", "/api/download"),
      jobCreateMethod: method,
      trackIdField: r.def("MEDIA_TRACK_ID_FIELD", "trackId"),
      jobExtraBody: r.json<Record<string, unknown>>("MEDIA_JOB_EXTRA_BODY"),
      jobStatusPath: r.path("MEDIA_JOB_STATUS_PATH", "/api/jobs/:jobId"),
      trackFields: mergeFieldMap(DEFAULT_TRACK_FIELDS, r.json<TrackFieldMap>("MEDIA_FIELD_MAP"), "MEDIA_FIELD_MAP", r.problems),
      jobFields: mergeFieldMap(DEFAULT_JOB_FIELDS, r.json<JobFieldMap>("MEDIA_JOB_FIELD_MAP"), "MEDIA_JOB_FIELD_MAP", r.problems),
      jobSuccessStates: r.list("MEDIA_JOB_SUCCESS_STATES", [
        "completed", "complete", "done", "ready", "success", "succeeded", "finished", "uploaded",
      ]),
      jobFailureStates: r.list("MEDIA_JOB_FAILURE_STATES", [
        "failed", "failure", "error", "errored", "cancelled", "canceled", "expired",
      ]),
      requestTimeoutMs,
      pollIntervalMs: r.int("MEDIA_JOB_POLL_INTERVAL_MS", 2_000, 1),
      maxJobWaitMs: r.int("MEDIA_JOB_MAX_WAIT_MS", 45_000, 1),
      jobRetries: r.int("MEDIA_JOB_RETRIES", 1, 0),
      jobConcurrency: r.int("MEDIA_JOB_CONCURRENCY", 2, 1),
      jobQueueTimeoutMs: r.int("MEDIA_JOB_QUEUE_TIMEOUT_MS", 30_000, 1),
      searchMaxPerMin: r.int("MEDIA_SEARCH_MAX_PER_MIN", 10, 1),
      streamAuth: r.oneOf("MEDIA_STREAM_AUTH", ["auto", "always", "never"] as const, "auto"),
      authMode,
      authModeSetting: authModeSetting ?? "auto",
      bearerToken: authMode === "bearer" ? bearerToken : undefined,
      supabase: {
        url: supabaseUrl ?? "",
        anonKey: anonKey ?? "",
        email,
        password,
        refreshToken,
        refreshMarginMs: r.int("MEDIA_TOKEN_REFRESH_MARGIN_MS", 60_000, 0),
        timeoutMs: requestTimeoutMs,
      },
      loginPath: r.path("MEDIA_LOGIN_PATH", "/api/auth/login"),
    };
  } else if (r.str("SUPABASE_URL") || r.str("MEDIA_USER_EMAIL")) {
    r.problems.push(
      frontendUrl
        ? "MEDIA_API_BASE is required when SUPABASE_* / MEDIA_USER_* are set — MEDIA_FRONTEND_URL discovery didn't find it"
        : "MEDIA_API_BASE is required when SUPABASE_* / MEDIA_USER_* are set (or set MEDIA_FRONTEND_URL to discover it)",
    );
  }

  let subsonic: SubsonicConfig | undefined;
  const subsonicUrl = r.url("SUBSONIC_URL");
  if (subsonicUrl) {
    const apiKey = r.str("SUBSONIC_API_KEY");
    const user = r.str("SUBSONIC_USER");
    const password = r.str("SUBSONIC_PASSWORD");
    if (!apiKey && !(user && password)) {
      r.problems.push("SUBSONIC_URL needs SUBSONIC_API_KEY or SUBSONIC_USER + SUBSONIC_PASSWORD");
    }
    subsonic = {
      baseUrl: subsonicUrl,
      user,
      password,
      apiKey,
      client: r.def("SUBSONIC_CLIENT", "80s-web"),
      timeoutMs: r.int("SUBSONIC_TIMEOUT_MS", 15_000, 1),
    };
  }

  const hifiRaw = r.list("HIFI_API_INSTANCES", []);
  const hifi: HiFiConfig | undefined = hifiRaw.length
    ? {
        instances: env.HIFI_API_INSTANCES!.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean),
        timeoutMs: r.int("HIFI_TIMEOUT_MS", 10_000, 1),
        cooldownMs: r.int("HIFI_COOLDOWN_MS", 60_000, 0),
      }
    : undefined;

  const providerOrder = r.list("PROVIDER_ORDER", []);

  const demoRaw = r.str("DEMO_MODE");
  const demo = demoRaw === undefined ? !remote && !subsonic && !hifi : r.bool("DEMO_MODE", false);

  const lastfmKey = r.str("LASTFM_API_KEY");
  const recommendations: RecommendationConfig = {
    lastfm: lastfmKey
      ? { apiKey: lastfmKey, baseUrl: r.url("LASTFM_API_BASE") ?? "https://ws.audioscrobbler.com/2.0" }
      : undefined,
    listenbrainz: r.bool("LISTENBRAINZ_ENABLED", true)
      ? {
          baseUrl: r.url("LISTENBRAINZ_API_BASE") ?? "https://api.listenbrainz.org",
          labsBaseUrl: r.url("LISTENBRAINZ_LABS_BASE") ?? "https://labs.api.listenbrainz.org",
          similarAlgorithm: r.str("LISTENBRAINZ_SIMILAR_ARTISTS_ALGORITHM"),
          token: r.str("LISTENBRAINZ_TOKEN"),
        }
      : undefined,
    musicbrainz: r.bool("MUSICBRAINZ_ENABLED", true)
      ? {
          baseUrl: r.url("MUSICBRAINZ_API_BASE") ?? "https://musicbrainz.org/ws/2",
          userAgent: r.def("MUSICBRAINZ_USER_AGENT", "80sWebPlayer/0.1 ( self-hosted; set MUSICBRAINZ_USER_AGENT )"),
        }
      : undefined,
    timeoutMs: r.int("RECOMMENDATION_TIMEOUT_MS", 8_000, 1),
    matchConcurrency: r.int("RECOMMENDATION_MATCH_CONCURRENCY", 3, 1),
    maxMatchLookups: r.int("RECOMMENDATION_MAX_MATCH_LOOKUPS", 3, 0),
    cacheTtlMs: r.int("RECOMMENDATION_CACHE_TTL_MS", 3_600_000, 0),
  };

  const config: Config = {
    // Heroku (DYNO is set) routes to $PORT on all interfaces; locally stay on loopback.
    host: r.def("HOST", env.DYNO ? "0.0.0.0" : "127.0.0.1"),
    port: r.int("PORT", 8787, 0),
    logLevel: r.def("LOG_LEVEL", "info"),
    trustProxy: r.bool("TRUST_PROXY", false),
    accessKey: r.str("APP_ACCESS_KEY"),
    clientDistDir: r.str("CLIENT_DIST_DIR"),
    redisUrl: r.str("REDIS_URL"),
    cachePrefix: r.def("CACHE_PREFIX", "80s:"),
    memoryCacheMaxEntries: r.int("MEMORY_CACHE_MAX_ENTRIES", 1_000, 1),
    frontendUrl,
    demo,
    providerOrder,
    hifi,
    remote,
    subsonic,
    fallbackCooldownMs: r.int("FALLBACK_COOLDOWN_MS", 30_000, 0),
    cacheTtl: {
      searchMs: r.int("SEARCH_CACHE_TTL_MS", 30 * 60_000, 0),
      // Guest (MEDIA_AUTH_MODE=none) links are usually short-lived: 20 min instead of 6 h.
      streamUrlMs: r.int("STREAM_URL_CACHE_TTL_MS", authMode === "none" ? 1_200_000 : 6 * 3_600_000, 0),
      trackMs: r.int("TRACK_CACHE_TTL_MS", 6 * 3_600_000, 0),
    },
    recommendations,
  };

  if (config.accessKey && config.accessKey.length < 12) {
    r.problems.push("APP_ACCESS_KEY must be at least 12 characters");
  }
  if (r.problems.length) throw new ConfigError(r.problems);
  return config;
}

/** Variables that only configure the media providers (ignored in fallback mode). */
const MEDIA_VARS = /^(MEDIA_|SUPABASE_|SUBSONIC_)/;

/**
 * Boot-time config: a broken media setup (missing Supabase values, bad field map, failed
 * discovery…) must not crash-loop the server. The media-provider variables are dropped and the
 * server starts in demo mode with `problems` set, so /api/health and /api/doctor can explain
 * what's wrong. Errors outside the media settings (a too-short APP_ACCESS_KEY, a bad PORT…)
 * still throw, so the server never starts with weaker access control than configured.
 */
export function loadConfigWithFallback(env: Env = process.env): { config: Config; problems: string[] } {
  try {
    return { config: loadConfig(env), problems: [] };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    const safe: Env = { DEMO_MODE: "true" };
    for (const [k, v] of Object.entries(env)) if (!MEDIA_VARS.test(k) && k !== "DEMO_MODE") safe[k] = v;
    return { config: loadConfig(safe), problems: err.problems };
  }
}
