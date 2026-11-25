import type { Track } from "../../../shared/api.js";

export type { Track };

/** Track as produced by a concrete provider: `id` is the provider's own id. */
export type ProviderTrack = Track;

export interface JobProgress {
  stage?: string;
  /** 0..1 */
  progress?: number;
}

export interface StreamOptions {
  signal?: AbortSignal;
  onProgress?: (progress: JobProgress) => void;
}

/** Where the audio bytes for a track can be fetched from (never sent to the browser). */
export interface StreamSource {
  url: string;
  /** Extra headers for the upstream request (e.g. bearer token for same-origin files). */
  headers?: Record<string, string>;
  /** Epoch ms after which `url` must not be reused (signed URL expiry). */
  expiresAt?: number;
  /** Fallback content type when the CDN answers with application/octet-stream. */
  mimeType?: string;
  /** File extension used for downloads (`flac`). */
  extension?: string;
}

export interface SearchOptions {
  limit?: number;
  signal?: AbortSignal;
}

/**
 * Contract every music source implements. Ids passed in and returned are the
 * provider's *own* ids; `ProviderChain` adds the public `<provider>:` prefix.
 */
export interface AudioProvider {
  readonly name: string;
  readonly kind: string;
  search(query: string, options?: SearchOptions): Promise<ProviderTrack[]>;
  /** Resolves `null` when the track does not exist. */
  getTrackMetadata(id: string): Promise<ProviderTrack | null>;
  getStreamUrl(id: string, options?: StreamOptions): Promise<StreamSource>;
  /** Optional cover-art proxy for providers whose image URLs embed credentials. */
  getCoverSource?(coverId: string): Promise<StreamSource>;
  /** Headers to add when fetching `source` (computed per request so tokens stay fresh). */
  authorizeStream?(source: StreamSource): Promise<Record<string, string>>;
  close?(): Promise<void> | void;
}

const LOSSLESS_FORMATS = new Set(["flac", "alac", "wav", "wave", "aiff", "aif", "ape", "wv", "dsf", "dff", "pcm"]);
const LOSSY_FORMATS = new Set(["mp3", "aac", "m4a", "ogg", "opus", "vorbis", "wma", "mp4", "webm"]);

export const MIME_BY_EXTENSION: Record<string, string> = {
  flac: "audio/flac",
  wav: "audio/wav",
  alac: "audio/mp4",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  aiff: "audio/aiff",
};

export function extensionForMime(mime: string | null | undefined): string | undefined {
  if (!mime) return undefined;
  const m = mime.toLowerCase();
  if (m.includes("flac")) return "flac";
  if (m.includes("wav") || m.includes("wave")) return "wav";
  if (m.includes("mpeg") || m.includes("mp3")) return "mp3";
  if (m.includes("mp4") || m.includes("m4a") || m.includes("aac")) return "m4a";
  if (m.includes("ogg") || m.includes("opus")) return "ogg";
  if (m.includes("aiff")) return "aiff";
  return undefined;
}

/**
 * Decide whether a track is lossless from whatever hints the upstream gives.
 * The primary server is a FLAC server, so "no hint" defaults to lossless.
 */
export function inferLossless(format?: string, quality?: string, defaultLossless = true): boolean {
  const f = format?.toLowerCase().replace(/^\./, "");
  if (f && LOSSLESS_FORMATS.has(f)) return true;
  if (f && LOSSY_FORMATS.has(f)) return false;
  const q = quality?.toUpperCase();
  if (q) {
    if (q.includes("LOSSLESS") || q.includes("HI_RES") || q.includes("HIRES") || q.includes("FLAC")) return true;
    if (q.includes("LOW") || q.includes("HIGH") || q.includes("MP3") || q.includes("AAC")) return false;
  }
  return defaultLossless;
}
