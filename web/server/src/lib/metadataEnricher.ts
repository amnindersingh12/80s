import type { Track } from "../../../shared/api.js";
import type { CacheStore } from "./cache.js";
import { mapLimit, SingleFlight } from "./concurrency.js";
import type { FetchFn } from "./http.js";
import { artistSimilarity, normalizeText, titleSimilarity } from "./text.js";

interface EnrichedFields {
  album?: string;
  albumArtist?: string;
  year?: number;
  trackNumber?: number;
  coverUrl?: string;
}

const ENRICH_TTL_MS = 24 * 60 * 60_000;
const inflight = new SingleFlight<EnrichedFields | null>();

interface ItunesSong {
  trackName?: string;
  artistName?: string;
  collectionName?: string;
  collectionArtistName?: string;
  trackNumber?: number;
  releaseDate?: string;
  artworkUrl100?: string;
}

/**
 * Fills missing album, albumArtist, year, trackNumber, and artwork metadata using the free
 * keyless iTunes Search API, cached per `artist|title` in Redis/memory to prevent rate-limit storms.
 */
export async function enrichTrackMetadata(
  track: Track,
  cache: CacheStore,
  fetchFn: FetchFn = fetch,
): Promise<Track> {
  const needsAlbum = !track.album;
  const needsYear = !track.year;
  const needsTrackNum = !track.trackNumber;
  const needsCover = !track.coverUrl;
  if (!needsAlbum && !needsYear && !needsTrackNum && !needsCover) return track;

  const key = `metaenrich:v1:${normalizeText(track.artist)}|${normalizeText(track.title)}`;
  const hit = await cache.get<EnrichedFields | null>(key);
  let extra: EnrichedFields | null | undefined = hit;

  if (extra === undefined) {
    extra = await inflight.run(key, async () => {
      const found = await lookupItunes(track.artist, track.title, fetchFn);
      await cache.set(key, found, ENRICH_TTL_MS);
      return found;
    });
  }
  if (!extra) return track;

  const cover = track.coverUrl ?? extra.coverUrl;
  return {
    ...track,
    ...(track.album ? {} : extra.album ? { album: extra.album } : {}),
    ...(track.albumArtist ? {} : extra.albumArtist ? { albumArtist: extra.albumArtist } : {}),
    ...(track.year ? {} : extra.year ? { year: extra.year } : {}),
    ...(track.trackNumber ? {} : extra.trackNumber ? { trackNumber: extra.trackNumber } : {}),
    ...(cover ? { coverUrl: cover, artworkUrl: track.artworkUrl ?? cover } : {}),
  };
}

export async function enrichTrackList(
  tracks: Track[],
  cache: CacheStore,
  fetchFn: FetchFn = fetch,
  maxLookups = 10,
): Promise<Track[]> {
  let remaining = maxLookups;
  return mapLimit(tracks, 4, async (t) => {
    if (t.album && t.year && t.coverUrl) return t;
    const key = `metaenrich:v1:${normalizeText(t.artist)}|${normalizeText(t.title)}`;
    const cached = await cache.get<EnrichedFields | null>(key);
    if (cached !== undefined) {
      if (!cached) return t;
      const cover = t.coverUrl ?? cached.coverUrl;
      return {
        ...t,
        ...(t.album ? {} : cached.album ? { album: cached.album } : {}),
        ...(t.albumArtist ? {} : cached.albumArtist ? { albumArtist: cached.albumArtist } : {}),
        ...(t.year ? {} : cached.year ? { year: cached.year } : {}),
        ...(t.trackNumber ? {} : cached.trackNumber ? { trackNumber: cached.trackNumber } : {}),
        ...(cover ? { coverUrl: cover, artworkUrl: t.artworkUrl ?? cover } : {}),
      };
    }
    if (remaining <= 0) return t;
    remaining--;
    return enrichTrackMetadata(t, cache, fetchFn).catch(() => t);
  });
}

async function lookupItunes(artist: string, title: string, fetchFn: FetchFn): Promise<EnrichedFields | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_500);
  try {
    const url = `https://itunes.apple.com/search?media=music&entity=song&limit=5&term=${encodeURIComponent(`${artist} ${title}`)}`;
    const res = await fetchFn(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: ItunesSong[] };
    const results = data.results ?? [];
    let best: ItunesSong | undefined;
    let bestScore = 0;
    for (const r of results) {
      const ts = titleSimilarity(title, r.trackName ?? "");
      const as = artistSimilarity(artist, r.artistName ?? "");
      if (ts < 0.7 || as < 0.55) continue;
      const score = ts * 0.6 + as * 0.4;
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    if (!best) return null;
    const yearMatch = best.releaseDate?.match(/^(\d{4})/);
    const cover = best.artworkUrl100?.replace(/\/\d+x\d+bb\./, "/600x600bb.");
    return {
      ...(best.collectionName ? { album: best.collectionName } : {}),
      ...(best.collectionArtistName || best.artistName ? { albumArtist: best.collectionArtistName ?? best.artistName } : {}),
      ...(yearMatch ? { year: Number(yearMatch[1]) } : {}),
      ...(best.trackNumber ? { trackNumber: best.trackNumber } : {}),
      ...(cover ? { coverUrl: cover } : {}),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
