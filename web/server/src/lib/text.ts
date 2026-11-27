/**
 * Text normalisation and fuzzy matching used to line up recommendation
 * metadata (Last.fm / ListenBrainz) with tracks from the media provider, and
 * to match tracks across providers during failover.
 */

const NOISE_PATTERNS: RegExp[] = [
  // (feat. X), [ft. X], (with X)
  /[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/giu,
  // (Remastered 2011), [Live], (Radio Edit), (Official Video) ...
  /[([][^)\]]*(?:remaster|live|edit|version|mix|mono|stereo|official|audio|video|lyric|explicit|deluxe|bonus)[^)\]]*[)\]]/giu,
  // " - Remastered 2009", " - Radio Edit"
  /\s[-–—]\s(?:\d{4}\s)?(?:remaster(?:ed)?|live|radio edit|single version|mono|stereo)\b.*$/giu,
  // trailing "feat. X" without brackets
  /\s(?:feat\.?|ft\.?|featuring)\s.*$/giu,
];

/** Lower-case, strip Latin diacritics and noise, keep letters/digits of any script. */
export function normalizeText(input: string | undefined | null): string {
  if (!input) return "";
  let s = input.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  for (const re of NOISE_PATTERNS) s = s.replace(re, " ");
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split an artist credit into individual normalised names. */
export function splitArtists(credit: string | undefined | null): string[] {
  if (!credit) return [];
  return credit
    .split(/\s*(?:,|&|\/|;|\bx\b|\bvs\.?\b|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b)\s*/iu)
    .map((a) => normalizeText(a))
    .filter(Boolean);
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const t = s.replace(/\s+/g, " ");
  const chars = Array.from(t);
  if (chars.length < 2) {
    if (chars.length === 1) out.set(t, 1);
    return out;
  }
  for (let i = 0; i < chars.length - 1; i++) {
    const g = (chars[i] as string) + (chars[i + 1] as string);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice coefficient over character bigrams of already-normalised strings. */
export function dice(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  let total = 0;
  for (const [g, n] of A) {
    total += n;
    const m = B.get(g);
    if (m) overlap += Math.min(n, m);
  }
  for (const n of B.values()) total += n;
  return total === 0 ? 0 : (2 * overlap) / total;
}

export function titleSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // "Song" vs "Song Pt 2" should not be a perfect match, but containment is a strong hint.
  const contained = na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na));
  return Math.max(dice(na, nb), contained ? 0.85 : 0);
}

/** Best pairwise similarity between the individual artists of two credits. */
export function artistSimilarity(a: string, b: string): number {
  const A = splitArtists(a);
  const B = splitArtists(b);
  if (!A.length || !B.length) return 0;
  let best = 0;
  for (const x of A) for (const y of B) best = Math.max(best, x === y ? 1 : dice(x, y));
  return best;
}

export function trackKey(artist: string, title: string): string {
  const primaryArtist = splitArtists(artist)[0] ?? normalizeText(artist);
  return `${primaryArtist}|${normalizeText(title)}`;
}

export interface MatchCandidate {
  title: string;
  artist: string;
  durationSec?: number;
  lossless?: boolean;
}

export interface MatchScore {
  score: number;
  title: number;
  artist: number;
  accepted: boolean;
}

/** Scores how likely `candidate` is the recording described by `wanted`. */
export function scoreMatch(
  wanted: { title: string; artist: string; durationSec?: number },
  candidate: MatchCandidate,
): MatchScore {
  const t = titleSimilarity(wanted.title, candidate.title);
  const a = artistSimilarity(wanted.artist, candidate.artist);
  let score = 0.6 * t + 0.4 * a;
  if (wanted.durationSec && candidate.durationSec) {
    const delta = Math.abs(wanted.durationSec - candidate.durationSec);
    if (delta <= 3) score += 0.05;
    else if (delta > 30) score -= 0.1;
  }
  if (candidate.lossless) score += 0.01; // tie-breaker towards lossless copies
  return { score, title: t, artist: a, accepted: t >= 0.8 && a >= 0.6 };
}

export function bestMatch<C extends MatchCandidate>(
  wanted: { title: string; artist: string; durationSec?: number },
  candidates: readonly C[],
): { candidate: C; score: MatchScore } | undefined {
  let best: { candidate: C; score: MatchScore } | undefined;
  for (const c of candidates) {
    const s = scoreMatch(wanted, c);
    if (s.accepted && (!best || s.score > best.score.score)) best = { candidate: c, score: s };
  }
  return best;
}

const FORBIDDEN_FILENAME = /[\u0000-\u001f\u007f<>:"/\\|?*]+/g;

/** "Artist - Title" safe for every major filesystem. */
export function safeFilename(base: string, ext: string, maxLength = 180): string {
  const cleaned = base
    .replace(FORBIDDEN_FILENAME, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  const truncated = Array.from(cleaned || "track").slice(0, maxLength).join("").trim();
  return `${truncated}.${ext.replace(/^\./, "")}`;
}

/** ASCII-only fallback for the legacy `filename=` parameter. */
export function asciiFilename(name: string): string {
  const ascii = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .replace(/_+/g, "_");
  return ascii.replace(/^_+(?=\.)/, "track");
}

/** `Content-Disposition` value with both legacy and RFC 5987 UTF-8 names. */
export function contentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encoded}`;
}
