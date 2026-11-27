import type { LyricsResponse } from "../../../shared/api.js";
import type { FetchFn } from "../lib/http.js";
import { normalizeText, titleSimilarity, artistSimilarity } from "../lib/text.js";

const LRCLIB_USER_AGENT = "80s-player/1.0 (https://github.com/amnindersingh12/80s)";
const CACHE_TTL_MS = 24 * 60 * 60_000;
const MAX_CACHE_ENTRIES = 1_000;
const TIMEOUT_MS = 5_000;

interface LrclibRecord {
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

export interface LyricsQuery {
  track: string;
  artist: string;
  album?: string;
  durationSec?: number;
}

export interface LyricsDeps {
  fetch?: FetchFn;
  now?: () => number;
}

interface CacheEntry {
  value: LyricsResponse;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function clearLyricsCache(): void {
  cache.clear();
}

/**
 * Fetches synced / plain lyrics from LRCLIB (`/api/get` with `/api/search` fallback)
 * and caches responses in memory. Never throws on network or upstream failures.
 */
export async function fetchLyrics(query: LyricsQuery, deps: LyricsDeps = {}): Promise<LyricsResponse> {
  const track = query.track.trim();
  const artist = query.artist.trim();
  const album = query.album?.trim() || undefined;
  const durationSec = query.durationSec && Number.isFinite(query.durationSec) && query.durationSec > 0
    ? Math.round(query.durationSec > 36_000 ? query.durationSec / 1000 : query.durationSec)
    : undefined;

  if (!track || !artist) {
    return { syncedLyrics: null, plainLyrics: null, instrumental: false, source: "none" };
  }

  const now = (deps.now ?? Date.now)();
  const cacheKey = `${normalizeText(artist)}|${normalizeText(track)}|${normalizeText(album ?? "")}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }

  const fetchFn = deps.fetch ?? fetch;
  let result: LyricsResponse;
  try {
    result = await queryLrclib({ track, artist, album, durationSec }, fetchFn);
  } catch {
    return { syncedLyrics: null, plainLyrics: null, instrumental: false, source: "none" };
  }

  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(cacheKey, { value: result, expiresAt: now + CACHE_TTL_MS });
  return result;
}

async function queryLrclib(
  q: { track: string; artist: string; album?: string; durationSec?: number },
  fetchFn: FetchFn,
): Promise<LyricsResponse> {
  const getUrl = new URL("https://lrclib.net/api/get");
  getUrl.searchParams.set("artist_name", q.artist);
  getUrl.searchParams.set("track_name", q.track);
  if (q.album) getUrl.searchParams.set("album_name", q.album);
  if (q.durationSec) getUrl.searchParams.set("duration", String(q.durationSec));

  const direct = await fetchJson<LrclibRecord>(getUrl.toString(), fetchFn);
  if (direct.status === 200 && direct.data) {
    const mapped = toResponse(direct.data);
    if (mapped.syncedLyrics || mapped.plainLyrics || mapped.instrumental) return mapped;
  }

  // Fallback to search when exact metadata doesn't match (or only album mismatch caused 404).
  const searchUrl = new URL("https://lrclib.net/api/search");
  searchUrl.searchParams.set("q", `${q.artist} ${q.track}`);
  const searched = await fetchJson<LrclibRecord[]>(searchUrl.toString(), fetchFn);
  if (searched.status === 200 && Array.isArray(searched.data) && searched.data.length > 0) {
    const best = pickBestRecord(searched.data, q);
    if (best) return toResponse(best);
  }

  if (direct.status === 404 && direct.data?.instrumental) {
    return { syncedLyrics: null, plainLyrics: null, instrumental: true, source: "lrclib" };
  }
  return { syncedLyrics: null, plainLyrics: null, instrumental: false, source: "none" };
}

async function fetchJson<T>(url: string, fetchFn: FetchFn): Promise<{ status: number; data?: T }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      headers: {
        "user-agent": LRCLIB_USER_AGENT,
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status };
    }
    const data = (await res.json()) as T;
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

function toResponse(r: LrclibRecord): LyricsResponse {
  const synced = r.syncedLyrics?.trim() || null;
  const plain = r.plainLyrics?.trim() || null;
  const instrumental = Boolean(r.instrumental);
  if (!synced && !plain && !instrumental) {
    return { syncedLyrics: null, plainLyrics: null, instrumental: false, source: "none" };
  }
  return { syncedLyrics: synced, plainLyrics: plain, instrumental, source: "lrclib" };
}

function pickBestRecord(
  records: LrclibRecord[],
  q: { track: string; artist: string; durationSec?: number },
): LrclibRecord | undefined {
  let best: LrclibRecord | undefined;
  let bestScore = -1;
  for (const r of records) {
    const hasSynced = Boolean(r.syncedLyrics?.trim());
    const hasPlain = Boolean(r.plainLyrics?.trim());
    if (!hasSynced && !hasPlain && !r.instrumental) continue;
    const tSim = titleSimilarity(q.track, r.trackName ?? "");
    const aSim = artistSimilarity(q.artist, r.artistName ?? "");
    if (tSim < 0.45 && aSim < 0.45) continue;
    let score = tSim * 0.55 + aSim * 0.45;
    if (hasSynced) score += 0.25;
    else if (hasPlain) score += 0.1;
    if (q.durationSec && r.duration && Math.abs(q.durationSec - r.duration) <= 4) score += 0.1;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}
