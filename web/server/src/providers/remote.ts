import { AppError } from "../errors.js";
import { Semaphore } from "../lib/concurrency.js";
import { pick, pickArray, pickNumber, pickString } from "../lib/fields.js";
import { fillPath, joinUrl, parseRetryAfterMs, requestJson, sleep as defaultSleep, type FetchFn, type JsonResponse } from "../lib/http.js";
import type { RemoteProviderConfig } from "../config.js";
import type { AlbumSummary, ArtistSummary } from "../../../shared/api.js";
import {
  MIME_BY_EXTENSION,
  inferLossless,
  parseFlacStreamInfo,
  verifyLosslessStream,
  type AudioProvider,
  type CatalogSearchResult,
  type JobProgress,
  type ProviderAlbumDetail,
  type ProviderArtistDetail,
  type ProviderTrack,
  type SearchOptions,
  type StreamOptions,
  type StreamSource,
} from "./types.js";

/**
 * Anything that can hand out bearer tokens: SupabaseAuth, a static MEDIA_BEARER_TOKEN, or
 * nothing at all (`undefined` → requests go out without an Authorization header).
 */
export interface TokenSource {
  getAccessToken(): Promise<string | undefined>;
  invalidate(rejectedToken?: string): void;
  /** false for static/no auth: a 401 is final, there is nothing to refresh. Default true. */
  readonly refreshable?: boolean;
  close?(): void;
}

export interface RemoteMediaProviderOptions {
  config: RemoteProviderConfig;
  auth: TokenSource;
  fetch?: FetchFn;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  name?: string;
}

interface JobState {
  jobId?: string;
  status?: string;
  url?: string;
  progress?: number;
  stage?: string;
  error?: string;
  expiresAt?: number;
  done: boolean;
  failed: boolean;
}

interface AuthedRequest {
  method?: "GET" | "POST" | "PUT";
  body?: unknown;
  timeoutMs: number;
  retries: number;
  signal?: AbortSignal;
  label: string;
}

class JobDeadline extends Error {}

/**
 * Adapter for the personal Fastify/REST media server.
 *
 * search → `GET {MEDIA_SEARCH_PATH}?{MEDIA_SEARCH_PARAM}=…` (15 s timeout)
 * stream → `POST {MEDIA_JOB_CREATE_PATH} {"{MEDIA_TRACK_ID_FIELD}": id}`, then
 *          poll `GET {MEDIA_JOB_STATUS_PATH}` every 2 s for at most 45 s until
 *          the job exposes a signed R2/CDN URL. At most `MEDIA_JOB_CONCURRENCY`
 *          (2) jobs run at once; the rest queue for `MEDIA_JOB_QUEUE_TIMEOUT_MS`.
 */
export class RemoteMediaProvider implements AudioProvider {
  readonly name: string;
  readonly kind = "remote-media";
  readonly semaphore: Semaphore;

  private readonly cfg: RemoteProviderConfig;
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly searchTimestamps: number[] = [];
  private readonly maxSearchesPerMin: number;

  constructor(private readonly options: RemoteMediaProviderOptions) {
    this.cfg = options.config;
    this.name = options.name ?? "remote";
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.maxSearchesPerMin = options.config.searchMaxPerMin ?? 10;
    this.semaphore = new Semaphore(this.cfg.jobConcurrency);
  }

  async search(query: string, options: SearchOptions = {}): Promise<ProviderTrack[]> {
    return (await this.searchCatalog(query, options)).tracks;
  }

  async searchCatalog(query: string, options: SearchOptions = {}): Promise<CatalogSearchResult> {
    const t = this.now();
    while (this.searchTimestamps.length && t - this.searchTimestamps[0]! >= 60_000) this.searchTimestamps.shift();
    if (this.searchTimestamps.length >= this.maxSearchesPerMin) {
      throw new AppError("UPSTREAM_UNAVAILABLE", "Media search rate limit reached; cooling down", {
        upstreamStatus: 429,
        provider: this.name,
        retryAfterMs: 60_000,
      });
    }
    this.searchTimestamps.push(t);

    const url = new URL(joinUrl(this.cfg.baseUrl, this.cfg.searchPath));
    for (const [k, v] of Object.entries(this.cfg.searchExtraParams)) url.searchParams.set(k, v);
    url.searchParams.set(this.cfg.searchParam, query);
    if (this.cfg.searchLimitParam && options.limit) {
      url.searchParams.set(this.cfg.searchLimitParam, String(options.limit));
    }

    const res = await this.authedJson(url.toString(), {
      timeoutMs: this.cfg.requestTimeoutMs,
      retries: 0,
      signal: options.signal,
      label: "Media search",
    });
    this.assertOk(res, "Media search");

    const tracks = pickArray(res.data, this.cfg.searchResultsPath)
      .map((raw) => this.mapTrack(raw))
      .filter((tr): tr is ProviderTrack => tr !== null);
    const limitedTracks = options.limit ? tracks.slice(0, options.limit) : tracks;

    const artists: ArtistSummary[] = pickArray(res.data, "data.artists.items|artists.items|artists")
      .map((raw): ArtistSummary | null => {
        const id = pickString(raw, "id");
        const name = pickString(raw, "name|name.display");
        if (!id || !name) return null;
        const img = pickString(raw, "image.large|image.medium|image.small|picture");
        return {
          id,
          name,
          ...(img ? { imageUrl: this.absolute(img) } : {}),
        };
      })
      .filter((x): x is ArtistSummary => x !== null)
      .slice(0, 12);

    const albums: AlbumSummary[] = pickArray(res.data, "data.albums.items|albums.items|albums")
      .map((raw): AlbumSummary | null => this.mapRemoteAlbumSummary(raw))
      .filter((x): x is AlbumSummary => x !== null)
      .slice(0, 12);

    return { tracks: limitedTracks, artists, albums };
  }

  async getArtist(id: string): Promise<ProviderArtistDetail | null> {
    const url = new URL(joinUrl(this.cfg.baseUrl, "/api/get-artist"));
    url.searchParams.set("artist_id", id);
    const res = await this.authedJson(url.toString(), {
      timeoutMs: this.cfg.requestTimeoutMs,
      retries: 1,
      label: "Artist lookup",
    });
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) return null;
    const raw = pick(res.data, "data.artist|artist") as Record<string, unknown> | undefined;
    if (!raw) return null;
    const name = pickString(raw, "name.display|name") ?? "Unknown artist";
    const imageUrl = pickString(raw, "images.portrait.hash|image.large|image.medium|picture");
    const rawBio = pickString(raw, "biography.content|bio");
    const topTracks = pickArray(raw, "top_tracks.items|top_tracks")
      .map((tr) => this.mapTrack(tr))
      .filter((tr): tr is ProviderTrack => tr !== null);
    const albums = pickArray(raw, "releases.items|releases|albums.items")
      .map((al) => this.mapRemoteAlbumSummary(al, name, id))
      .filter((al): al is AlbumSummary => al !== null);
    return {
      id,
      name,
      ...(imageUrl && /^https?:\/\//i.test(imageUrl) ? { imageUrl } : {}),
      ...(rawBio ? { bio: rawBio } : {}),
      genres: [],
      topTracks,
      albums,
    };
  }

  async getAlbum(id: string): Promise<ProviderAlbumDetail | null> {
    const url = new URL(joinUrl(this.cfg.baseUrl, "/api/get-album"));
    url.searchParams.set("album_id", id);
    const res = await this.authedJson(url.toString(), {
      timeoutMs: this.cfg.requestTimeoutMs,
      retries: 1,
      label: "Album lookup",
    });
    if (res.status === 404) return null;
    if (res.status < 200 || res.status >= 300) return null;
    const raw = pick(res.data, "data|album") as Record<string, unknown> | undefined;
    if (!raw) return null;
    const summary = this.mapRemoteAlbumSummary(raw);
    if (!summary) return null;
    const rawTracks = pickArray(raw, "tracks.items|tracks");
    const tracks = rawTracks
      .map((tr) =>
        this.mapTrack({
          ...(typeof tr === "object" && tr ? (tr as Record<string, unknown>) : {}),
          album: raw,
          artist: (typeof tr === "object" && tr && "performer" in tr ? (tr as { performer?: unknown }).performer : undefined) ?? raw["artist"],
        }),
      )
      .filter((tr): tr is ProviderTrack => tr !== null)
      .sort((a, b) => (a.trackNumber ?? 9999) - (b.trackNumber ?? 9999));
    const totalDurationMs = tracks.reduce((sum, tr) => sum + (tr.durationMs ?? (tr.durationSec ?? 0) * 1000), 0);
    const bitDepth = pickNumber(raw, "maximum_bit_depth|bitDepth");
    const sampleRate = normalizeSampleRate(pickNumber(raw, "maximum_sampling_rate|sampleRate"));
    const isHiRes = (bitDepth !== undefined && bitDepth > 16) || (sampleRate !== undefined && sampleRate > 48_000);
    return {
      id: summary.id,
      title: summary.title,
      artist: summary.artist,
      ...(summary.artistId ? { artistId: summary.artistId } : {}),
      ...(summary.coverUrl ? { coverUrl: summary.coverUrl } : {}),
      ...(summary.year ? { year: summary.year } : {}),
      trackCount: pickNumber(raw, "tracks_count") ?? tracks.length,
      totalDurationMs,
      codec: "FLAC",
      ...(bitDepth ? { bitDepth } : {}),
      ...(sampleRate ? { sampleRate } : {}),
      qualityTier: isHiRes ? "HI-RES LOSSLESS" : "LOSSLESS",
      tracks,
    };
  }

  private mapRemoteAlbumSummary(raw: unknown, fallbackArtist?: string, fallbackArtistId?: string): AlbumSummary | null {
    const id = pickString(raw, "id|album_id|upc");
    const title = pickString(raw, "title|name");
    if (!id || !title) return null;
    const artist = pickString(raw, "artist.name|artists.0.name|artist") ?? fallbackArtist ?? "Unknown artist";
    const artistId = pickString(raw, "artist.id|artists.0.id") ?? fallbackArtistId;
    const cover = pickString(raw, "image.large|image.small|image.thumbnail|coverUrl|cover|artwork");
    const coverUrl = cover && (/^https?:\/\//i.test(cover) || cover.startsWith("/")) ? this.absolute(cover) : undefined;
    const year =
      yearFromDate(pickString(raw, "release_date_original|releaseDate|release_date")) ??
      pickNumber(raw, "year");
    const bitDepth = pickNumber(raw, "maximum_bit_depth|bitDepth");
    const sampleRate = normalizeSampleRate(pickNumber(raw, "maximum_sampling_rate|sampleRate"));
    const isHiRes = (bitDepth !== undefined && bitDepth > 16) || (sampleRate !== undefined && sampleRate > 48_000);
    return {
      id,
      title,
      artist,
      ...(artistId ? { artistId } : {}),
      ...(coverUrl ? { coverUrl } : {}),
      ...(year ? { year } : {}),
      ...(pickNumber(raw, "tracks_count|trackCount") ? { trackCount: pickNumber(raw, "tracks_count|trackCount") } : {}),
      codec: "FLAC",
      ...(bitDepth ? { bitDepth } : {}),
      ...(sampleRate ? { sampleRate } : {}),
      qualityTier: isHiRes ? "HI-RES LOSSLESS" : "LOSSLESS",
    };
  }

  async getTrackMetadata(id: string): Promise<ProviderTrack | null> {
    if (!this.cfg.trackPath) return null;
    const url = joinUrl(this.cfg.baseUrl, fillPath(this.cfg.trackPath, { id, trackId: id }));
    const res = await this.authedJson(url, {
      timeoutMs: this.cfg.requestTimeoutMs,
      retries: 1,
      label: "Track lookup",
    });
    if (res.status === 404) return null;
    this.assertOk(res, "Track lookup");
    const raw = pick(res.data, "track|data.track|data") ?? res.data;
    return this.mapTrack(raw);
  }

  getStreamUrl(id: string, options: StreamOptions = {}): Promise<StreamSource> {
    return this.semaphore.use(() => this.runJob(id, options), {
      timeoutMs: this.cfg.jobQueueTimeoutMs,
      signal: options.signal,
    });
  }

  /** Adds the bearer token for files hosted on the media server itself. */
  async authorizeStream(source: StreamSource): Promise<Record<string, string>> {
    if (!this.needsAuth(source.url)) return {};
    const token = await this.options.auth.getAccessToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  close(): void {
    this.options.auth.close?.();
  }

  // ---------------------------------------------------------------- jobs ---

  private async runJob(id: string, { signal, onProgress }: StreamOptions): Promise<StreamSource> {
    const startedAt = this.now();
    const deadlineAt = startedAt + this.cfg.maxJobWaitMs;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new JobDeadline()), this.cfg.maxJobWaitMs);
    const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    const remaining = () => Math.max(1, deadlineAt - this.now());
    const report = (p: JobProgress) => {
      try {
        onProgress?.(p);
      } catch {
        /* progress listeners must never break the job */
      }
    };

    try {
      report({ stage: "queued" });
      const created = await this.createJobWithLosslessFallback(id, remaining, combined);
      if (created.status === 404) throw new AppError("NOT_FOUND", "Track not found on the media server", { upstreamStatus: 404, provider: this.name });
      this.assertOk(created, "Job creation");
      this.assertLosslessJobPayload(created.data);

      let state = this.readJob(created.data);
      if (state.failed) throw this.jobFailed(state);
      // Already packaged (cache hit upstream): the URL comes straight back.
      if (state.url && (state.done || !state.jobId)) return await this.probeSource(this.toSource(state), combined);
      if (!state.jobId) {
        throw new AppError("UPSTREAM_BAD_RESPONSE", "Job creation returned neither a job id nor a URL", { provider: this.name });
      }
      const jobId = state.jobId;
      report({ stage: state.stage ?? state.status ?? "pending", progress: state.progress });

      const statusUrl = joinUrl(this.cfg.baseUrl, fillPath(this.cfg.jobStatusPath, { jobId, id: jobId, trackId: id }));
      for (;;) {
        await this.sleep(Math.min(this.cfg.pollIntervalMs, remaining()), combined);
        if (this.now() >= deadlineAt) throw new JobDeadline();

        const polled = await this.authedJson(statusUrl, {
          timeoutMs: Math.min(this.cfg.requestTimeoutMs, remaining()),
          retries: this.cfg.jobRetries,
          signal: combined,
          label: "Job status",
        });
        if (polled.status === 404) {
          throw new AppError("JOB_FAILED", "The media server lost track of the packaging job", { upstreamStatus: 404, provider: this.name });
        }
        this.assertOk(polled, "Job status");

        state = this.readJob(polled.data);
        report({ stage: state.stage ?? state.status, progress: state.progress });
        if (state.failed) throw this.jobFailed(state);
        if (state.done) {
          if (!state.url) {
            throw new AppError("UPSTREAM_BAD_RESPONSE", "Job finished but no download URL was returned", { provider: this.name });
          }
          return await this.probeSource(this.toSource(state), combined);
        }
      }
    } catch (err) {
      if (err instanceof JobDeadline || (deadline.signal.aborted && !signal?.aborted)) {
        throw new AppError(
          "JOB_TIMEOUT",
          `The media server is still preparing this track after ${Math.round(this.cfg.maxJobWaitMs / 1000)} s. Try again shortly.`,
          { provider: this.name },
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  private async createJobWithLosslessFallback(id: string, remaining: () => number, signal: AbortSignal): Promise<JsonResponse> {
    const createUrl = new URL(joinUrl(this.cfg.baseUrl, fillPath(this.cfg.jobCreatePath, { id, trackId: id })));
    const isGet = this.cfg.jobCreateMethod === "GET";
    if (isGet) createUrl.searchParams.set(this.cfg.trackIdField, id);

    const qualities = createUrl.searchParams.get("quality") === "27" ? ["27", "7", "6"] : [null];
    let lastRes!: JsonResponse;
    for (const q of qualities) {
      if (q) createUrl.searchParams.set("quality", q);
      lastRes = await this.authedJson(createUrl.toString(), {
        method: this.cfg.jobCreateMethod,
        body: isGet ? undefined : { ...this.cfg.jobExtraBody, [this.cfg.trackIdField]: id },
        timeoutMs: Math.min(this.cfg.requestTimeoutMs, remaining()),
        retries: this.cfg.jobRetries,
        signal,
        label: "Job creation",
      });
      if (lastRes.status >= 200 && lastRes.status < 300) return lastRes;
      if (!q || (lastRes.status !== 400 && lastRes.status !== 404 && lastRes.status !== 422)) return lastRes;
    }
    return lastRes;
  }

  private assertLosslessJobPayload(data: unknown): void {
    const mime = pickString(data, "mimeType|mime_type|contentType");
    const check = verifyLosslessStream(mime);
    if (!check.ok) {
      throw new AppError("UPSTREAM_UNAVAILABLE", check.reason ?? "Lossy stream rejected", { provider: this.name });
    }
  }

  private readJob(data: unknown): JobState {
    const f = this.cfg.jobFields;
    const status = pickString(data, f.status)?.toLowerCase();
    let progress = pickNumber(data, f.progress);
    if (progress !== undefined) progress = Math.max(0, Math.min(1, progress > 1 ? progress / 100 : progress));
    const rawUrl = pickString(data, f.url);
    const expires = pick(data, f.expiresAt);
    return {
      jobId: pickString(data, f.jobId),
      status,
      url: rawUrl ? this.absolute(rawUrl) : undefined,
      progress,
      stage: pickString(data, f.stage),
      error: pickString(data, f.error),
      expiresAt: parseExpiry(expires),
      done: status !== undefined && this.cfg.jobSuccessStates.includes(status),
      failed: status !== undefined && this.cfg.jobFailureStates.includes(status),
    };
  }

  private jobFailed(state: JobState): AppError {
    const detail = state.error ? `: ${state.error.slice(0, 200)}` : "";
    return new AppError("JOB_FAILED", `The media server could not prepare this track${detail}`, { provider: this.name });
  }

  private async probeSource(source: StreamSource, signal: AbortSignal): Promise<StreamSource> {
    let res: Response;
    try {
      const authHeaders = await this.authorizeStream(source);
      res = await this.fetchFn(source.url, {
        method: "GET",
        headers: { ...authHeaders, range: "bytes=0-63" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(4_000, this.cfg.requestTimeoutMs))]),
        redirect: "follow",
      });
    } catch {
      return source;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return source;
    }
    const headBytes = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
    const check = verifyLosslessStream(res.headers.get("content-type"), headBytes.length ? headBytes : undefined);
    if (!check.ok) {
      throw new AppError("UPSTREAM_UNAVAILABLE", check.reason ?? "Lossy stream rejected (FLAC/ALAC only)", {
        provider: this.name,
      });
    }
    const rangeMatch = res.headers.get("content-range")?.match(/\/(\d+)\s*$/);
    const lenHdr = res.headers.get("content-length");
    const parsedLen = rangeMatch ? Number(rangeMatch[1]) : res.status === 200 && lenHdr ? Number(lenHdr) : undefined;
    const contentLength = parsedLen !== undefined && Number.isFinite(parsedLen) && parsedLen > 0 ? parsedLen : undefined;
    const flacInfo = headBytes.length ? parseFlacStreamInfo(headBytes) : undefined;
    return {
      ...source,
      ...(check.mimeType ? { mimeType: check.mimeType } : {}),
      ...(check.extension ? { extension: check.extension } : {}),
      ...(check.codec ? { codec: check.codec } : {}),
      ...(contentLength !== undefined ? { contentLength } : {}),
      ...(flacInfo?.bitDepth ? { bitDepth: flacInfo.bitDepth } : {}),
      ...(flacInfo?.sampleRate ? { sampleRate: flacInfo.sampleRate } : {}),
    };
  }

  private toSource(state: JobState): StreamSource {
    const url = state.url as string;
    const ext = extensionFromUrl(url) ?? "flac";
    if (["mp3", "aac", "ogg", "opus", "vorbis", "webm"].includes(ext)) {
      throw new AppError("UPSTREAM_UNAVAILABLE", `Lossy extension ".${ext}" rejected (FLAC/ALAC only)`, { provider: this.name });
    }
    return {
      url,
      expiresAt: state.expiresAt ?? expiryFromSignedUrl(url),
      mimeType: MIME_BY_EXTENSION[ext] ?? "audio/flac",
      extension: ext,
    };
  }

  // -------------------------------------------------------------- helpers ---

  private async authedJson(url: string, req: AuthedRequest): Promise<JsonResponse> {
    const send = async (token: string | undefined) =>
      requestJson(url, {
        method: req.method ?? "GET",
        body: req.body,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        timeoutMs: req.timeoutMs,
        retries: req.retries,
        signal: req.signal,
        fetch: this.fetchFn,
        label: req.label,
        provider: this.name,
      });

    const auth = this.options.auth;
    const token = await auth.getAccessToken();
    let res = await send(token);
    if (res.status === 401) {
      if (auth.refreshable === false) {
        const hint = token ? "MEDIA_BEARER_TOKEN was rejected" : "it needs credentials: set MEDIA_AUTH_MODE=bearer or supabase";
        throw new AppError("UPSTREAM_AUTH_FAILED", `The media server answered 401 (${hint})`, { upstreamStatus: 401, provider: this.name });
      }
      // Token revoked or clock skew: refresh once and replay.
      auth.invalidate(token);
      res = await send(await auth.getAccessToken());
      if (res.status === 401) {
        throw new AppError("UPSTREAM_AUTH_FAILED", "The media server rejected our session", { upstreamStatus: 401, provider: this.name });
      }
    }
    if (res.status === 403) {
      throw new AppError("UPSTREAM_AUTH_FAILED", "The media server denied access for this account", { upstreamStatus: 403, provider: this.name });
    }
    return res;
  }

  private assertOk(res: JsonResponse, label: string): void {
    if (res.status >= 200 && res.status < 300) return;
    if (res.status === 404) throw new AppError("NOT_FOUND", `${label}: not found`, { upstreamStatus: 404, provider: this.name });
    if (res.status === 429) {
      throw new AppError("UPSTREAM_UNAVAILABLE", `${label} rate-limited (HTTP 429)`, {
        upstreamStatus: 429,
        provider: this.name,
        retryAfterMs: parseRetryAfterMs(res.headers, res.data),
      });
    }
    throw new AppError("UPSTREAM_BAD_RESPONSE", `${label} failed with HTTP ${res.status}`, { upstreamStatus: res.status, provider: this.name });
  }

  private absolute(url: string): string {
    return /^https?:\/\//i.test(url) ? url : joinUrl(this.cfg.baseUrl, url);
  }

  private needsAuth(url: string): boolean {
    if (this.cfg.streamAuth === "always") return true;
    if (this.cfg.streamAuth === "never") return false;
    try {
      return new URL(url).origin === new URL(this.cfg.baseUrl).origin;
    } catch {
      return false;
    }
  }

  mapTrack(raw: unknown): ProviderTrack | null {
    if (!raw || typeof raw !== "object") return null;
    const f = this.cfg.trackFields;
    const id = pickString(raw, f.id);
    const title = pickString(raw, f.title);
    if (!id || !title) return null;

    const durationMs = pickNumber(raw, f.durationMs);
    let durationSec = pickNumber(raw, f.durationSec);
    if (durationSec === undefined && durationMs !== undefined) durationSec = durationMs / 1000;
    if (durationSec !== undefined && durationSec > 36_000) durationSec = durationSec / 1000; // ms in disguise

    const cover = pickString(raw, f.coverUrl);
    const coverUrl = cover && (/^https?:\/\//i.test(cover) || cover.startsWith("/")) ? this.absolute(cover) : undefined;
    const format = pickString(raw, f.format)?.toLowerCase().replace(/^\./, "");
    const quality = pickString(raw, f.quality);
    const year = pickNumber(raw, f.year) ?? yearFromDate(pickString(raw, "releaseDate|release_date|album.releaseDate"));

    return compact({
      id,
      provider: this.name,
      title,
      artist: pickString(raw, f.artist) ?? "Unknown artist",
      artistId: pickString(raw, "artist.id|artists.0.id|artistId|performer.id"),
      album: pickString(raw, f.album),
      albumId: pickString(raw, "album.id|albumId|album_id|album.qobuz_id"),
      albumArtist: pickString(raw, f.albumArtist),
      durationSec: durationSec !== undefined ? Math.round(durationSec) : undefined,
      coverUrl,
      format: format ?? "flac",
      lossless: inferLossless(format, quality),
      bitDepth: pickNumber(raw, f.bitDepth),
      sampleRate: normalizeSampleRate(pickNumber(raw, f.sampleRate)),
      bitrateKbps: pickNumber(raw, f.bitrateKbps),
      fileSize: pickNumber(raw, "fileSize|file_size|size"),
      year,
      trackNumber: pickNumber(raw, f.trackNumber),
      isrc: pickString(raw, f.isrc),
    });
  }
}

function compact<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

function yearFromDate(s?: string): number | undefined {
  const m = s?.match(/^(\d{4})/);
  return m ? Number(m[1]) : undefined;
}

/** 44.1 → 44100, 96000 stays 96000. */
function normalizeSampleRate(n?: number): number | undefined {
  if (n === undefined) return undefined;
  return n < 1000 ? Math.round(n * 1000) : Math.round(n);
}

function extensionFromUrl(url: string): string | undefined {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return m?.[1]?.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Accepts ISO strings, epoch seconds or epoch milliseconds. */
export function parseExpiry(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value) {
    if (/^\d+$/.test(value)) return parseExpiry(Number(value));
    const t = Date.parse(value);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/**
 * Reads the expiry baked into presigned URLs: AWS SigV4 (Cloudflare R2, S3:
 * `X-Amz-Date` + `X-Amz-Expires`) or legacy `Expires=<epoch seconds>`.
 */
export function expiryFromSignedUrl(url: string): number | undefined {
  try {
    const q = new URL(url).searchParams;
    const date = q.get("X-Amz-Date") ?? q.get("x-amz-date");
    const ttl = q.get("X-Amz-Expires") ?? q.get("x-amz-expires");
    if (date && ttl) {
      const m = date.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      if (m) {
        const [, y, mo, d, h, mi, s] = m.map(Number) as number[];
        return Date.UTC(y!, mo! - 1, d!, h!, mi!, s!) + Number(ttl) * 1000;
      }
    }
    const expires = q.get("Expires") ?? q.get("expires");
    if (expires && /^\d+$/.test(expires)) return Number(expires) * 1000;
  } catch {
    /* not a URL we understand */
  }
  return undefined;
}
