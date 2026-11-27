import type {
  AlbumDetailResponse,
  ArtistDetailResponse,
  DoctorResponse,
  ErrorCode,
  HealthResponse,
  HomeResponse,
  LyricsResponse,
  PrepareStatus,
  RadioRequest,
  RadioResponse,
  RecommendationSeed,
  RecommendationsResponse,
  SearchFilterType,
  SearchResponse,
  Track,
} from "../../shared/api";

export type UiErrorCode = ErrorCode | "NETWORK";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: UiErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type Listener = () => void;
const accessListeners = new Set<Listener>();
/** Fires whenever the server says the access key is required (401 ACCESS_REQUIRED). */
export function onAccessRequired(fn: Listener): () => void {
  accessListeners.add(fn);
  return () => accessListeners.delete(fn);
}

async function request<T>(path: string, init: RequestInit = {}, accept: (status: number, body: unknown) => boolean = () => false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiError(0, "NETWORK", "Can't reach the player server. Check your connection.", true);
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (res.ok || accept(res.status, body)) return body as T;

  const err = (body as { error?: { code?: UiErrorCode; message?: string; retryable?: boolean } } | null)?.error;
  if (err?.code === "ACCESS_REQUIRED") accessListeners.forEach((fn) => fn());
  throw new ApiError(res.status, err?.code ?? "INTERNAL", err?.message ?? `Request failed (HTTP ${res.status})`, err?.retryable ?? res.status >= 500);
}

const isStatus = (_: number, body: unknown) => Boolean(body && typeof body === "object" && "state" in body);

function seedQuery(seed: RecommendationSeed, limit?: number): string {
  const q = new URLSearchParams({ type: seed.type });
  if (seed.trackId) q.set("trackId", seed.trackId);
  if (seed.artist) q.set("artist", seed.artist);
  if (seed.title) q.set("title", seed.title);
  if (seed.tag) q.set("tag", seed.tag);
  if (limit) q.set("limit", String(limit));
  return q.toString();
}

const enc = encodeURIComponent;

export const api = {
  health: (signal?: AbortSignal) => request<HealthResponse>("/api/health", { signal }),
  /** Live config diagnostics (same as `npm run doctor`); needs APP_ACCESS_KEY on the server. */
  doctor: (q?: string, signal?: AbortSignal) => request<DoctorResponse>(`/api/doctor${q ? `?q=${encodeURIComponent(q)}` : ""}`, { signal }),
  unlock: (key: string) => request<{ ok: boolean }>("/api/session", { method: "POST", body: JSON.stringify({ key }) }),
  lock: () => request<{ ok: boolean }>("/api/session", { method: "DELETE" }),
  search: (q: string, type: SearchFilterType = "all", signal?: AbortSignal) =>
    request<SearchResponse>(`/api/search?q=${enc(q)}&type=${enc(type)}&limit=30`, { signal }),
  artist: (id: string, name?: string, signal?: AbortSignal) => {
    const p = new URLSearchParams();
    if (name) p.set("name", name);
    const qs = p.toString();
    return request<ArtistDetailResponse>(`/api/artists/${enc(id)}${qs ? `?${qs}` : ""}`, { signal });
  },
  album: (id: string, opts?: { title?: string; artist?: string }, signal?: AbortSignal) => {
    const p = new URLSearchParams();
    if (opts?.title) p.set("title", opts.title);
    if (opts?.artist) p.set("artist", opts.artist);
    const qs = p.toString();
    return request<AlbumDetailResponse>(`/api/albums/${enc(id)}${qs ? `?${qs}` : ""}`, { signal });
  },
  home: (
    opts: { genre?: string; nowPlayingArtist?: string; nowPlayingTrack?: string; seedArtist?: string; seedTrack?: string; limit?: number } = {},
    signal?: AbortSignal,
  ) => {
    const p = new URLSearchParams();
    if (opts.genre) p.set("genre", opts.genre);
    if (opts.nowPlayingArtist) p.set("nowPlayingArtist", opts.nowPlayingArtist);
    if (opts.nowPlayingTrack) p.set("nowPlayingTrack", opts.nowPlayingTrack);
    if (opts.seedArtist) p.set("seedArtist", opts.seedArtist);
    if (opts.seedTrack) p.set("seedTrack", opts.seedTrack);
    if (opts.limit) p.set("limit", String(opts.limit));
    return request<HomeResponse>(`/api/home?${p.toString()}`, { signal });
  },
  /** Starts (or joins) the upstream job; resolves with the status even for 5xx job errors. */
  prepare: (id: string) => request<PrepareStatus>(`/api/tracks/${enc(id)}/prepare`, { method: "POST" }, isStatus),
  prepareStatus: (id: string) => request<PrepareStatus>(`/api/tracks/${enc(id)}/prepare`, {}, isStatus),
  recommendations: (seed: RecommendationSeed, signal?: AbortSignal) =>
    request<RecommendationsResponse>(`/api/recommendations?${seedQuery(seed, 24)}`, { signal }),
  radio: (body: RadioRequest, signal?: AbortSignal) =>
    request<RadioResponse>("/api/radio", { method: "POST", body: JSON.stringify(body), signal }),
  lyrics: (q: { track: string; artist: string; album?: string; duration?: number }, signal?: AbortSignal) => {
    const p = new URLSearchParams({ track: q.track, artist: q.artist });
    if (q.album) p.set("album", q.album);
    if (q.duration) p.set("duration", String(Math.round(q.duration)));
    return request<LyricsResponse>(`/api/lyrics?${p.toString()}`, { signal });
  },
  /** Reads the JSON error behind a failed <audio> load (the element itself can't). */
  probeStream: async (id: string): Promise<ApiError | null> => {
    try {
      const res = await fetch(streamUrl(id), { headers: { range: "bytes=0-0" } });
      if (res.ok) {
        await res.body?.cancel();
        return null;
      }
      const body = (await res.json().catch(() => null)) as { error?: { code: UiErrorCode; message: string; retryable?: boolean } } | null;
      return new ApiError(res.status, body?.error?.code ?? "STREAM_UNAVAILABLE", body?.error?.message ?? `Stream failed (HTTP ${res.status})`, body?.error?.retryable ?? true);
    } catch {
      return new ApiError(0, "NETWORK", "Lost connection to the player server.", true);
    }
  },
};

export function streamUrl(id: string): string {
  return `/api/stream/${enc(id)}`;
}

export function downloadUrl(track: Pick<Track, "id" | "artist" | "title">): string {
  return `/api/download/${enc(track.id)}?artist=${enc(track.artist)}&title=${enc(track.title)}`;
}

export function describeError(err: unknown): { message: string; code: UiErrorCode; retryable: boolean } {
  if (err instanceof ApiError) return { message: err.message, code: err.code, retryable: err.retryable };
  return { message: err instanceof Error ? err.message : "Something went wrong", code: "INTERNAL", retryable: true };
}
