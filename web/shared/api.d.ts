/**
 * Wire types shared by the API server and the web client.
 *
 * This is a declaration-only file on purpose: both sides import it with
 * `import type`, so nothing here exists at runtime and the server build
 * does not need to emit it.
 */

/** A playable (or at least resolvable) track exposed by an AudioProvider. */
export interface Track {
  /** Public id, always `<provider>:<providerTrackId>` (e.g. `remote:123`). */
  id: string;
  /** Name of the provider that owns this track (`remote`, `subsonic`, `mock`). */
  provider: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
  albumId?: string;
  albumArtist?: string;
  durationSec?: number;
  durationMs?: number;
  /** Either a public https URL or a same-origin `/api/cover/:id` proxy path. */
  coverUrl?: string;
  artworkUrl?: string;
  /** Container / codec hint, lower-case (`flac`, `wav`, `alac`, `mp3`). */
  format?: string;
  codec?: "FLAC" | "ALAC";
  lossless: boolean;
  qualityTier?: "HI-RES LOSSLESS" | "LOSSLESS";
  bitDepth?: number;
  sampleRate?: number;
  bitrateKbps?: number;
  fileSize?: number;
  year?: number;
  trackNumber?: number;
  isrc?: string;
}

export interface ArtistSummary {
  id: string;
  name: string;
  imageUrl?: string;
  genres?: string[];
  provider?: string;
}

export interface AlbumSummary {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  coverUrl?: string;
  year?: number;
  trackCount?: number;
  codec?: "FLAC" | "ALAC";
  bitDepth?: number;
  sampleRate?: number;
  qualityTier?: "HI-RES LOSSLESS" | "LOSSLESS";
  provider?: string;
}

export type SearchFilterType = "all" | "tracks" | "artists" | "albums";

export type SearchTopResult =
  | { kind: "track"; item: Track }
  | { kind: "artist"; item: ArtistSummary }
  | { kind: "album"; item: AlbumSummary };

export interface SearchResponse {
  query: string;
  type?: SearchFilterType;
  topResult?: SearchTopResult;
  tracks: Track[];
  artists?: ArtistSummary[];
  albums?: AlbumSummary[];
  /** Provider that actually answered. */
  provider: string;
  /** True when the primary provider failed and a fallback answered. */
  fallback: boolean;
  cached: boolean;
}

export interface ArtistDetailResponse {
  id: string;
  name: string;
  imageUrl?: string;
  bio?: string;
  genres: string[];
  topTracks: Track[];
  albums: AlbumSummary[];
  similarArtists: SimilarArtist[];
}

export interface AlbumDetailResponse {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  coverUrl?: string;
  year?: number;
  trackCount: number;
  totalDurationMs: number;
  codec: "FLAC" | "ALAC";
  bitDepth?: number;
  sampleRate?: number;
  qualityTier: "HI-RES LOSSLESS" | "LOSSLESS";
  tracks: Track[];
}

export type PrepareState = "idle" | "preparing" | "ready" | "error";

export interface PrepareStatus {
  id: string;
  state: PrepareState;
  /** Free-form upstream stage, e.g. `queued`, `packaging`, `uploading`. */
  stage?: string;
  /** 0..1 when the upstream job reports progress. */
  progress?: number;
  startedAt?: number;
  elapsedMs?: number;
  /** Provider that produced the stream URL (differs from the track's on failover). */
  servedBy?: string;
  fallback?: boolean;
  /** Short-lived stream URL (`/api/stream/:id?st=...`) usable without X-Access-Key header. */
  signedStreamUrl?: string;
  fileSize?: number;
  codec?: "FLAC" | "ALAC";
  bitDepth?: number;
  sampleRate?: number;
  bitrateKbps?: number;
  error?: ApiErrorBody["error"];
}

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Upstream HTTP status, when relevant. */
    upstreamStatus?: number;
    retryable?: boolean;
  };
}

export type ErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "ACCESS_REQUIRED"
  | "UPSTREAM_TIMEOUT"
  | "JOB_TIMEOUT"
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_AUTH_FAILED"
  | "UPSTREAM_BAD_RESPONSE"
  | "JOB_FAILED"
  | "PROVIDER_BUSY"
  | "STREAM_UNAVAILABLE"
  | "NOT_CONFIGURED"
  | "INTERNAL";

export type SeedType = "track" | "artist" | "tag";

export interface RecommendationSeed {
  type: SeedType;
  /** Provider track id; resolved to artist + title server-side. */
  trackId?: string;
  artist?: string;
  title?: string;
  /** Genre / regional tag, e.g. `punjabi pop`, `indie`, `hip-hop`. */
  tag?: string;
}

export type RecommendationSource = "lastfm" | "listenbrainz" | "musicbrainz";
export type SourceState = "ok" | "error" | "disabled" | "skipped";

export interface SimilarArtist {
  name: string;
  mbid?: string;
  /** 0..1, merged across sources. */
  score: number;
  sources: RecommendationSource[];
  imageUrl?: string;
  /** True when the active provider returned at least one track by this artist. */
  playable: boolean;
}

export type Availability = "playable" | "metadata-only";

export interface RecommendedTrack {
  /** Stable normalised key (`artist|title`) used for dedupe and radio exclusion. */
  key: string;
  title: string;
  artist: string;
  album?: string;
  albumArtist?: string;
  durationSec?: number;
  durationMs?: number;
  coverUrl?: string;
  artworkUrl?: string;
  mbid?: string;
  score: number;
  sources: RecommendationSource[];
  availability: Availability;
  /** The matched provider track when `availability === "playable"`. */
  track?: Track;
  /** Short human reason, e.g. `Similar to Karma Police`. */
  reason?: string;
}

export interface RecommendationsResponse {
  seed: RecommendationSeed & { label: string };
  similarArtists: SimilarArtist[];
  relatedTracks: RecommendedTrack[];
  /** Tags discovered for the seed (useful as follow-up genre chips). */
  tags: string[];
  sources: Record<RecommendationSource, SourceState>;
  warnings: string[];
}

export interface RadioRequest {
  seed: RecommendationSeed;
  /** Track ids and/or recommendation keys that must not be returned again. */
  exclude?: string[];
  limit?: number;
}

export interface RadioResponse {
  seed: RecommendationSeed & { label: string };
  tracks: Array<Track & { reason?: string; key: string }>;
  /** True when the candidate pool ran dry; the client should re-seed to keep going. */
  exhausted: boolean;
  warnings: string[];
}

export interface ResolveTrackRequest {
  title: string;
  artist: string;
  album?: string;
}

export interface ResolveTrackResponse {
  track: Track;
  prepare: PrepareStatus;
  signedStreamUrl: string;
}

export interface LyricsResponse {
  syncedLyrics: string | null;
  plainLyrics: string | null;
  instrumental: boolean;
  source: "lrclib" | "none";
}

export interface HomeResponse extends RecommendationsResponse {
  genre: string;
  seedArtist?: string;
  nowPlaying?: { artist: string; track: string };
  becauseYouPlayed?: { label: string; tracks: RecommendedTrack[] };
  featuredTrack?: Track;
  albums?: AlbumSummary[];
}

export interface ProviderHealth {
  name: string;
  kind: string;
  role: "primary" | "fallback";
  circuit: "closed" | "open";
  lastError?: string;
}

export interface HealthResponse {
  ok: true;
  demo: boolean;
  providers: ProviderHealth[];
  recommendations: Record<RecommendationSource, boolean>;
  cache: "memory" | "redis";
  /** How the server authenticates to MEDIA_API_BASE (null when no media server is configured). */
  mediaAuth: "none" | "bearer" | "supabase" | "login" | null;
  /**
   * Media-config problems found at boot. Non-empty means the server ignored the media
   * settings and runs in demo mode; `/api/doctor` shows the full details.
   */
  configErrors: string[];
  /** MEDIA_FRONTEND_URL auto-discovery at startup (`off` also when every value is set explicitly). */
  discovery: "off" | "ok" | "partial" | "failed";
  accessRequired: boolean;
  authenticated: boolean;
}

/** `GET /api/doctor` — live configuration diagnostics (needs APP_ACCESS_KEY). */
export interface DoctorResponse {
  ok: boolean;
  steps: { name: string; status: "ok" | "warn" | "fail" | "skip" }[];
  /** The same text `npm run doctor` prints (secrets masked). */
  lines: string[];
  ranAt: string;
  durationMs: number;
}
