import type { RecommendationSource } from "../../../shared/api.js";

/** A track suggestion from one metadata source, before merging. */
export interface TrackCandidate {
  title: string;
  artist: string;
  album?: string;
  durationSec?: number;
  mbid?: string;
  coverUrl?: string;
  /** 0..1 within its source. */
  score: number;
  source: RecommendationSource;
  reason?: string;
}

export interface ArtistCandidate {
  name: string;
  mbid?: string;
  imageUrl?: string;
  score: number;
  source: RecommendationSource;
}

/** Score for the i-th of n ranked results: 1.0 for the first, ~0.2 for the last. */
export function rankScore(i: number, n: number): number {
  if (n <= 1) return 1;
  return 1 - (i / (n - 1)) * 0.8;
}
