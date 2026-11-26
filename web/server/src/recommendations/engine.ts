import type {
  RadioResponse,
  RecommendationSeed,
  RecommendationSource,
  RecommendationsResponse,
  RecommendedTrack,
  SimilarArtist,
  SourceState,
  Track,
} from "../../../shared/api.js";
import { AppError } from "../errors.js";
import type { CacheStore } from "../lib/cache.js";
import { mapLimit } from "../lib/concurrency.js";
import { artistSimilarity, bestMatch, normalizeText, splitArtists, trackKey } from "../lib/text.js";
import type { ProviderChain } from "../providers/chain.js";
import type { LastfmClient } from "./lastfm.js";
import type { ListenBrainzClient } from "./listenbrainz.js";
import type { MusicBrainzClient } from "./musicbrainz.js";
import type { ArtistCandidate, TrackCandidate } from "./types.js";

/** Relative trust in each source when merging scores. */
const SOURCE_WEIGHT: Record<RecommendationSource, number> = { lastfm: 1, listenbrainz: 0.9, musicbrainz: 0.6 };

/** Search-friendly aliases for common genre / regional seeds. */
const TAG_ALIASES: Record<string, string[]> = {
  "punjabi pop": ["punjabi", "bhangra", "punjabi pop", "punjabi hip hop", "sidhu moose wala"],
  punjabi: ["punjabi", "bhangra", "punjabi pop"],
  bhangra: ["bhangra", "punjabi", "desi"],
  "hip-hop": ["hip hop", "hip-hop", "rap"],
  hiphop: ["hip hop", "rap"],
  "hip hop": ["hip hop", "rap"],
  indie: ["indie", "indie rock", "indie pop"],
  "lo-fi": ["lo-fi", "lofi", "chillhop"],
  lofi: ["lo-fi", "lofi", "chillhop"],
  synthwave: ["synthwave", "retrowave", "outrun"],
  "r&b": ["rnb", "r&b", "contemporary r&b"],
  bollywood: ["bollywood", "hindi pop", "indian pop", "filmi"],
  "80s": ["80s", "new wave", "synth-pop"],
};

export interface EngineDeps {
  chain: ProviderChain;
  cache: CacheStore;
  lastfm?: LastfmClient;
  listenbrainz?: ListenBrainzClient;
  musicbrainz?: MusicBrainzClient;
  cacheTtlMs: number;
  matchConcurrency: number;
  /** Cap uncached provider searches during `recommend()` (default unlimited for tests; 3 in prod). */
  maxMatchLookups?: number;
  /** Optional artwork resolver for artists/tracks lacking covers when Last.fm is disabled. */
  artworkLookup?: (query: string) => Promise<string | undefined>;
  log?: (msg: string, err?: unknown) => void;
}

interface ResolvedSeed extends RecommendationSeed {
  label: string;
  artist?: string;
  title?: string;
  tag?: string;
}

interface CandidatePool {
  artists: SimilarArtistDraft[];
  tracks: TrackDraft[];
  tags: string[];
  sources: Record<RecommendationSource, SourceState>;
  warnings: string[];
}

interface TrackDraft extends Omit<RecommendedTrack, "availability" | "track"> {}
interface SimilarArtistDraft extends Omit<SimilarArtist, "playable"> {}

type SourceTask = () => Promise<{ artists?: ArtistCandidate[]; tracks?: TrackCandidate[]; tags?: string[] }>;

export function expandTag(tag: string): string[] {
  const t = tag.trim().toLowerCase();
  const aliases = TAG_ALIASES[t] ?? [t];
  const words = t.split(/[\s/]+/).filter((w) => w.length > 2 && !["pop", "rock", "music", "the"].includes(w));
  return [...new Set([...aliases, ...words])];
}

/**
 * Builds "similar artists", "related tracks" and radio queues from open
 * metadata APIs, then checks every suggestion against the active provider so
 * the UI can tell playable tracks from metadata-only ones.
 */
export class RecommendationEngine {
  constructor(private readonly deps: EngineDeps) {}

  get enabledSources(): Record<RecommendationSource, boolean> {
    return {
      lastfm: Boolean(this.deps.lastfm),
      listenbrainz: Boolean(this.deps.listenbrainz),
      musicbrainz: Boolean(this.deps.musicbrainz),
    };
  }

  async recommend(seed: RecommendationSeed, options: { limit?: number } = {}): Promise<RecommendationsResponse> {
    const limit = clamp(options.limit ?? 20, 1, 50);
    const resolved = await this.resolveSeed(seed);
    const pool = await this.pool(resolved);
    const seedKey = resolved.type === "track" && resolved.artist && resolved.title ? trackKey(resolved.artist, resolved.title) : undefined;

    const ranked = diversify(pool.tracks.filter((t) => t.key !== seedKey), 2).slice(0, limit);
    const warnings = [...pool.warnings];
    let matchFailed = false;
    let remainingLookups = this.deps.maxMatchLookups ?? Number.POSITIVE_INFINITY;
    const relatedTracks = await mapLimit(ranked, this.deps.matchConcurrency, async (t) => {
      const cacheKey = `recmatch:v1:${t.key}`;
      const cached = await this.deps.cache.get<Track | null>(cacheKey);
      if (cached !== undefined) {
        return cached
          ? { ...t, availability: "playable" as const, track: cached, coverUrl: t.coverUrl ?? cached.coverUrl }
          : { ...t, availability: "metadata-only" as const };
      }
      if (remainingLookups <= 0) return { ...t, availability: "metadata-only" as const };
      remainingLookups--;
      try {
        const track = await this.match(t);
        await this.deps.cache.set(cacheKey, track ?? null, this.deps.cacheTtlMs);
        return track ? { ...t, availability: "playable" as const, track, coverUrl: t.coverUrl ?? track.coverUrl } : { ...t, availability: "metadata-only" as const };
      } catch {
        matchFailed = true;
        return { ...t, availability: "metadata-only" as const };
      }
    });

    const playableArtists = new Set(
      relatedTracks.filter((t) => t.availability === "playable").map((t) => normalizeText(splitArtists(t.artist)[0] ?? t.artist)),
    );
    const similarArtists =
      this.deps.maxMatchLookups !== undefined
        ? pool.artists.slice(0, 12).map((a) => ({ ...a, playable: playableArtists.has(normalizeText(a.name)) }))
        : await mapLimit(pool.artists.slice(0, 12), this.deps.matchConcurrency, async (a) => ({
            ...a,
            playable: await this.artistPlayable(a.name).catch(() => false),
          }));
    if (matchFailed) warnings.push("Could not check availability for some tracks; the media server did not answer.");

    const finalTracks = [...relatedTracks];
    if (this.deps.maxMatchLookups !== undefined && finalTracks.filter((t) => t.availability === "playable").length < Math.min(8, limit)) {
      const q = resolved.type === "tag" ? (expandTag(resolved.tag as string)[0] ?? resolved.tag!) : (resolved.artist ?? resolved.label);
      const seen = new Set(finalTracks.map((t) => t.key));
      const backfill = await this.deps.chain.search(q, { limit }).catch(() => null);
      const extras: typeof finalTracks = [];
      for (const t of backfill?.tracks ?? []) {
        const k = trackKey(t.artist, t.title);
        if (seen.has(k) || k === seedKey) continue;
        seen.add(k);
        extras.push({
          key: k,
          title: t.title,
          artist: t.artist,
          ...(t.album ? { album: t.album } : {}),
          ...(t.durationSec ? { durationSec: t.durationSec } : {}),
          coverUrl: t.coverUrl,
          score: 0.45,
          sources: ["listenbrainz"],
          reason: resolved.type === "tag" ? `Top ${resolved.label}` : `Related to ${resolved.label}`,
          availability: "playable",
          track: t,
        });
      }
      if (extras.length > 0) {
        const playable = finalTracks.filter((t) => t.availability === "playable");
        const metaOnly = finalTracks.filter((t) => t.availability !== "playable");
        finalTracks.length = 0;
        finalTracks.push(...[...playable, ...extras, ...metaOnly].slice(0, limit));
      }
    }

    const trackCoverByArtist = new Map<string, string>();
    for (const t of finalTracks) {
      if (!t.coverUrl) continue;
      const primary = normalizeText(splitArtists(t.artist)[0] ?? t.artist);
      if (primary && !trackCoverByArtist.has(primary)) trackCoverByArtist.set(primary, t.coverUrl);
    }
    let finalArtists =
      this.deps.maxMatchLookups !== undefined
        ? similarArtists.map((a) =>
            a.imageUrl ? a : { ...a, ...(trackCoverByArtist.get(normalizeText(a.name)) ? { imageUrl: trackCoverByArtist.get(normalizeText(a.name)) } : {}) },
          )
        : [...similarArtists];
    if (finalArtists.length < 6 && finalTracks.length > 0) {
      const seenArtists = new Set(finalArtists.map((a) => normalizeText(a.name)));
      for (const t of finalTracks) {
        if (finalArtists.length >= 12) break;
        const primary = splitArtists(t.artist)[0] ?? t.artist;
        const ak = normalizeText(primary);
        if (!ak || seenArtists.has(ak) || (resolved.artist && artistSimilarity(primary, resolved.artist) >= 0.9)) continue;
        seenArtists.add(ak);
        finalArtists.push({ name: primary, score: t.score * 0.5, sources: t.sources, playable: t.availability === "playable", ...(t.coverUrl ? { imageUrl: t.coverUrl } : {}) });
      }
    }
    if (this.deps.maxMatchLookups !== undefined && this.deps.artworkLookup) {
      const missingArtists = finalArtists.filter((a) => !a.imageUrl).slice(0, 4);
      const artHits = await Promise.all(
        missingArtists.map(async (a) => ({
          key: normalizeText(a.name),
          url: await this.lookupArtwork(a.name),
        })),
      );
      const artByKey = new Map(artHits.filter((h) => h.url).map((h) => [h.key, h.url as string]));
      if (artByKey.size > 0) {
        finalArtists = finalArtists.map((a) => {
          const hit = artByKey.get(normalizeText(a.name));
          return a.imageUrl || !hit ? a : { ...a, imageUrl: hit };
        });
      }
    }

    return {
      seed: { ...seed, ...pick(resolved), label: resolved.label },
      similarArtists: finalArtists,
      relatedTracks: finalTracks,
      tags: pool.tags,
      sources: pool.sources,
      warnings,
    };
  }

  /**
   * Returns up to `limit` playable tracks for a continuous radio station,
   * skipping anything in `exclude` (track ids or recommendation keys).
   */
  async radio(seed: RecommendationSeed, options: { exclude?: string[]; limit?: number } = {}): Promise<RadioResponse> {
    const limit = clamp(options.limit ?? 15, 1, 50);
    const exclude = new Set(options.exclude ?? []);
    const resolved = await this.resolveSeed(seed);
    if (resolved.trackId) exclude.add(resolved.trackId);
    if (resolved.type === "track" && resolved.artist && resolved.title) exclude.add(trackKey(resolved.artist, resolved.title));

    const pool = await this.pool(resolved);
    const candidates = diversify(pool.tracks, 2).filter((t) => !exclude.has(t.key));
    const picked: RadioResponse["tracks"] = [];
    const seenIds = new Set<string>();

    // Match in small waves so we stop hitting the media server once the queue is full.
    let cursor = 0;
    while (picked.length < limit && cursor < candidates.length) {
      const wave = candidates.slice(cursor, cursor + Math.max(this.deps.matchConcurrency * 2, limit - picked.length));
      cursor += wave.length;
      const matches = await mapLimit(wave, this.deps.matchConcurrency, (t) => this.match(t).catch(() => undefined));
      wave.forEach((t, i) => {
        const m = matches[i];
        if (!m || picked.length >= limit || exclude.has(m.id) || seenIds.has(m.id)) return;
        seenIds.add(m.id);
        picked.push({ ...m, key: t.key, ...(t.reason ? { reason: t.reason } : {}) });
      });
    }

    // Personal libraries rarely hold the exact deep cuts metadata services suggest, so fill
    // the rest of the station with library tracks by the recommended artists (and the seed artist).
    if (picked.length < limit) {
      const names: string[] = [];
      const seen = new Set<string>();
      const addName = (n: string | undefined) => {
        const k = normalizeText(n ?? "");
        if (k && !seen.has(k)) {
          seen.add(k);
          names.push(n as string);
        }
      };
      if (resolved.type !== "tag") addName(resolved.artist);
      pool.artists.forEach((a) => addName(a.name));
      candidates.forEach((t) => addName(primaryArtist(t.artist)));
      const perArtist = await mapLimit(names.slice(0, 16), this.deps.matchConcurrency, (name) =>
        this.deps.chain.search(name, { limit: 10 }).then((r) => ({ name, tracks: r.tracks })).catch(() => ({ name, tracks: [] as Track[] })),
      );
      for (const { name, tracks } of perArtist) {
        let taken = 0;
        for (const t of tracks) {
          if (picked.length >= limit || taken >= 2) break;
          const key = trackKey(t.artist, t.title);
          if (artistSimilarity(t.artist, name) < 0.85 || exclude.has(t.id) || exclude.has(key) || seenIds.has(t.id)) continue;
          seenIds.add(t.id);
          picked.push({ ...t, key, reason: `More by ${name}` });
          taken++;
        }
      }
    }

    return {
      seed: { ...seed, ...pick(resolved), label: resolved.label },
      tracks: diversify(picked, 2),
      exhausted: cursor >= candidates.length && picked.length < limit,
      warnings: pool.warnings,
    };
  }

  // ------------------------------------------------------------- seeding ---

  private async resolveSeed(seed: RecommendationSeed): Promise<ResolvedSeed> {
    if (seed.type === "track") {
      let { artist, title } = seed;
      if (seed.trackId && (!artist || !title)) {
        const t = await this.deps.chain.getTrack(seed.trackId).catch(() => null);
        artist ??= t?.artist;
        title ??= t?.title;
      }
      if (!artist || !title) throw new AppError("BAD_REQUEST", "A track seed needs trackId (known to the server) or artist + title");
      return { ...seed, type: "track", artist, title, label: `${title} — ${artist}` };
    }
    if (seed.type === "artist") {
      if (!seed.artist?.trim()) throw new AppError("BAD_REQUEST", "An artist seed needs artist");
      return { ...seed, type: "artist", artist: seed.artist.trim(), label: seed.artist.trim() };
    }
    if (seed.type === "tag") {
      if (!seed.tag?.trim()) throw new AppError("BAD_REQUEST", "A tag seed needs tag");
      const tag = seed.tag.trim().toLowerCase();
      return { ...seed, type: "tag", tag, label: tag.replace(/\b\p{L}/gu, (c) => c.toUpperCase()) };
    }
    throw new AppError("BAD_REQUEST", "seed type must be track, artist or tag");
  }

  // ---------------------------------------------------------- collection ---

  private async pool(seed: ResolvedSeed): Promise<CandidatePool> {
    const key = `recpool:v1:${seed.type}:${normalizeText(seed.artist ?? "")}:${normalizeText(seed.title ?? "")}:${normalizeText(seed.tag ?? "")}`;
    const cached = await this.deps.cache.get<CandidatePool>(key);
    if (cached) return cached;

    const pool = await this.collect(seed);
    // Don't pin an empty / fully failed pool for an hour.
    if (pool.tracks.length > 0) await this.deps.cache.set(key, pool, this.deps.cacheTtlMs);
    return pool;
  }

  private async collect(seed: ResolvedSeed): Promise<CandidatePool> {
    const { lastfm, listenbrainz, musicbrainz } = this.deps;
    const sources: Record<RecommendationSource, SourceState> = {
      lastfm: lastfm ? "ok" : "disabled",
      listenbrainz: listenbrainz ? "ok" : "disabled",
      musicbrainz: musicbrainz ? "ok" : "disabled",
    };
    const warnings: string[] = [];
    const tasks: Array<[RecommendationSource, SourceTask]> = [];

    // MusicBrainz resolves the artist MBID that ListenBrainz needs; share the promise.
    const artistMbid = seed.artist && musicbrainz ? musicbrainz.findArtist(seed.artist).catch(() => undefined) : Promise.resolve(undefined);

    if (seed.type === "track" || seed.type === "artist") {
      const artist = seed.artist as string;
      if (lastfm) {
        tasks.push(["lastfm", async () => {
          const [similar, artists, tags] = await Promise.all([
            seed.type === "track" ? lastfm.similarTracks(artist, seed.title as string, 50) : Promise.resolve([]),
            lastfm.similarArtists(artist, 20),
            lastfm.artistTopTags(artist).catch(() => []),
          ]);
          let tracks = similar;
          // Artist seeds (or obscure tracks): top tracks of the seed + its closest neighbours.
          if (tracks.length < 10) {
            const neighbours = artists.slice(0, 6);
            const tops = await Promise.all([
              lastfm.artistTopTracks(artist, seed.type === "artist" ? 6 : 3, `Top track by ${artist}`).catch(() => []),
              ...neighbours.map((a) =>
                lastfm
                  .artistTopTracks(a.name, 4, `${a.name} · similar to ${artist}`)
                  .then((ts) => ts.map((t) => ({ ...t, score: t.score * a.score })))
                  .catch(() => []),
              ),
            ]);
            tracks = [...tracks, ...tops.flat()];
          }
          return { tracks, artists, tags };
        }]);
      }
      if (listenbrainz) {
        tasks.push(["listenbrainz", async () => {
          const mbid = await artistMbid;
          if (!mbid) return {};
          const reason = seed.type === "track" ? `Similar to ${seed.title}` : `Because you like ${artist}`;
          return listenbrainz.artistRadio(mbid.mbid, { reason });
        }]);
      }
      if (musicbrainz) {
        tasks.push(["musicbrainz", async () => {
          const mbid = await artistMbid;
          return mbid ? { tags: await musicbrainz.artistTags(mbid.mbid) } : {};
        }]);
      }
    } else {
      const tag = seed.tag as string;
      const tags = expandTag(tag);
      if (lastfm) {
        tasks.push(["lastfm", async () => {
          const [tracks, artists] = await Promise.all([lastfm.tagTopTracks(tag, 50), lastfm.tagTopArtists(tag, 20)]);
          // Fall back to an alias when Last.fm has no chart for the exact phrase.
          const alias = tags.find((t) => t !== tag);
          if (!tracks.length && alias) {
            const [t2, a2] = await Promise.all([lastfm.tagTopTracks(alias, 50), lastfm.tagTopArtists(alias, 20)]);
            return { tracks: t2, artists: a2 };
          }
          return { tracks, artists };
        }]);
      }
      if (listenbrainz) {
        tasks.push(["listenbrainz", async () => ({ tracks: await listenbrainz.tagRadio(tags, 60, `Tagged ${tag}`) })]);
      }
      if (musicbrainz) {
        tasks.push(["musicbrainz", async () => ({ tracks: await musicbrainz.recordingsByTag(tags[0] ?? tag, 25, `Tagged ${tag}`) })]);
      }
    }

    const results = await Promise.allSettled(tasks.map(([, run]) => run()));
    const trackMap = new Map<string, TrackDraft>();
    const artistMap = new Map<string, SimilarArtistDraft>();
    const tagSet = new Map<string, number>();

    results.forEach((r, i) => {
      const source = (tasks[i] as [RecommendationSource, SourceTask])[0];
      if (r.status === "rejected") {
        sources[source] = "error";
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        warnings.push(`${SOURCE_LABEL[source]}: ${msg}`);
        this.deps.log?.(`recommendation source ${source} failed`, r.reason);
        return;
      }
      const { tracks = [], artists = [], tags = [] } = r.value;
      if (!tracks.length && !artists.length && !tags.length) sources[source] = "skipped";
      for (const t of tracks) mergeTrack(trackMap, t);
      for (const a of artists) mergeArtist(artistMap, a);
      tags.forEach((t, idx) => tagSet.set(t, (tagSet.get(t) ?? 0) + (tags.length - idx)));
    });

    // Artists implied by suggested tracks fill the "similar artists" row for tag seeds.
    if (artistMap.size < 6) {
      for (const t of [...trackMap.values()].sort((a, b) => b.score - a.score)) {
        const name = t.artist;
        const k = normalizeText(splitArtists(name)[0] ?? name);
        if (seed.artist && artistSimilarity(name, seed.artist) >= 0.9) continue;
        if (!artistMap.has(k)) artistMap.set(k, { name, score: t.score * 0.5, sources: [...t.sources] });
        if (artistMap.size >= 12) break;
      }
    }
    if (seed.artist) {
      for (const [k, a] of artistMap) if (artistSimilarity(a.name, seed.artist) >= 0.9) artistMap.delete(k);
    }

    if (!tasks.length) warnings.push("No recommendation sources are enabled.");
    else if (!lastfm) warnings.push("Tip: set LASTFM_API_KEY for richer similar-track results.");

    const maxScore = Math.max(1e-9, ...[...trackMap.values()].map((t) => t.score));
    const maxArtist = Math.max(1e-9, ...[...artistMap.values()].map((a) => a.score));
    return {
      tracks: [...trackMap.values()].map((t) => ({ ...t, score: round(t.score / maxScore) })).sort((a, b) => b.score - a.score),
      artists: [...artistMap.values()].map((a) => ({ ...a, score: round(a.score / maxArtist) })).sort((a, b) => b.score - a.score),
      tags: [...tagSet.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).filter((t) => t !== seed.tag).slice(0, 10),
      sources,
      warnings,
    };
  }

  // ------------------------------------------------------------ matching ---

  private async match(t: Pick<TrackDraft, "artist" | "title" | "durationSec">): Promise<Track | undefined> {
    const primaryArtist = splitArtists(t.artist)[0] ?? t.artist;
    const { tracks } = await this.deps.chain.search(`${primaryArtist} ${t.title}`, { limit: 8 });
    return bestMatch({ title: t.title, artist: t.artist, durationSec: t.durationSec }, tracks)?.candidate;
  }

  private async artistPlayable(name: string): Promise<boolean> {
    const { tracks } = await this.deps.chain.search(name, { limit: 8 });
    return tracks.some((t) => artistSimilarity(t.artist, name) >= 0.85);
  }

  private async lookupArtwork(query: string): Promise<string | undefined> {
    const lookup = this.deps.artworkLookup;
    if (!lookup) return undefined;
    const key = `artwork:v1:${normalizeText(query)}`;
    const cached = await this.deps.cache.get<string | null>(key);
    if (cached !== undefined) return cached ?? undefined;
    const url = await lookup(query).catch(() => undefined);
    await this.deps.cache.set(key, url ?? null, this.deps.cacheTtlMs);
    return url;
  }
}

const SOURCE_LABEL: Record<RecommendationSource, string> = { lastfm: "Last.fm", listenbrainz: "ListenBrainz", musicbrainz: "MusicBrainz" };

function mergeTrack(map: Map<string, TrackDraft>, c: TrackCandidate): void {
  const key = trackKey(c.artist, c.title);
  if (!key.split("|")[1]) return;
  const weighted = c.score * SOURCE_WEIGHT[c.source];
  const prev = map.get(key);
  if (!prev) {
    map.set(key, {
      key,
      title: c.title,
      artist: c.artist,
      ...(c.album ? { album: c.album } : {}),
      ...(c.durationSec ? { durationSec: c.durationSec } : {}),
      ...(c.coverUrl ? { coverUrl: c.coverUrl } : {}),
      ...(c.mbid ? { mbid: c.mbid } : {}),
      ...(c.reason ? { reason: c.reason } : {}),
      score: weighted,
      sources: [c.source],
    });
    return;
  }
  // Agreement between sources is the strongest signal we have: scores add up.
  prev.score += weighted;
  if (!prev.sources.includes(c.source)) prev.sources.push(c.source);
  prev.album ??= c.album;
  prev.durationSec ??= c.durationSec;
  prev.coverUrl ??= c.coverUrl;
  prev.mbid ??= c.mbid;
}

function mergeArtist(map: Map<string, SimilarArtistDraft>, a: ArtistCandidate): void {
  const key = normalizeText(a.name);
  if (!key) return;
  const weighted = a.score * SOURCE_WEIGHT[a.source];
  const prev = map.get(key);
  if (!prev) {
    map.set(key, {
      name: a.name,
      ...(a.mbid ? { mbid: a.mbid } : {}),
      ...(a.imageUrl ? { imageUrl: a.imageUrl } : {}),
      score: weighted,
      sources: [a.source],
    });
    return;
  }
  prev.score += weighted;
  if (!prev.sources.includes(a.source)) prev.sources.push(a.source);
  prev.mbid ??= a.mbid;
  prev.imageUrl ??= a.imageUrl;
}

/** Keeps the order by score but allows at most `perArtist` tracks per artist before deferring extras. */
export function diversify<T extends { artist: string }>(items: readonly T[], perArtist: number): T[] {
  const counts = new Map<string, number>();
  const head: T[] = [];
  const tail: T[] = [];
  for (const item of items) {
    const k = splitArtists(item.artist)[0] ?? normalizeText(item.artist);
    const n = counts.get(k) ?? 0;
    counts.set(k, n + 1);
    (n < perArtist ? head : tail).push(item);
  }
  return [...head, ...tail];
}

/** First credited artist in its original spelling ("AP Dhillon, Gurinder Gill" → "AP Dhillon"). */
export function primaryArtist(credit: string): string {
  return credit.split(/\s*(?:,|&|;|\/|\s(?:feat\.?|ft\.?|featuring|x|with)\s)\s*/i)[0]?.trim() || credit;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function pick(s: ResolvedSeed): Partial<RecommendationSeed> {
  return {
    ...(s.artist ? { artist: s.artist } : {}),
    ...(s.title ? { title: s.title } : {}),
    ...(s.tag ? { tag: s.tag } : {}),
  };
}
