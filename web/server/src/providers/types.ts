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
  /** Total byte length learned during stream probing (avoids an extra HEAD round-trip). */
  contentLength?: number;
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

const LOSSY_MIME_RE = /\b(mpeg|mp3|aac|ogg|opus|vorbis|webm|mp4a)\b/i;

/** Rejects explicit lossy MIME types or known lossy magic headers (`ID3`, MP3 sync, `OggS`, ADTS, `mp4a` without `alac`). */
export function verifyLosslessStream(
  mime: string | null | undefined,
  headBytes?: Uint8Array,
): { ok: boolean; codec?: "FLAC" | "ALAC"; mimeType?: string; extension?: string; reason?: string } {
  const m = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  if (m && LOSSY_MIME_RE.test(m)) {
    return { ok: false, reason: `Lossy content-type "${m}" rejected (FLAC/ALAC only)` };
  }
  if (headBytes && headBytes.length >= 4) {
    // fLaC
    if (headBytes[0] === 0x66 && headBytes[1] === 0x4c && headBytes[2] === 0x61 && headBytes[3] === 0x43) {
      return { ok: true, codec: "FLAC", mimeType: "audio/flac", extension: "flac" };
    }
    // ID3 or MPEG ADTS/MP3 frame sync
    const isId3 = headBytes[0] === 0x49 && headBytes[1] === 0x44 && headBytes[2] === 0x33;
    const isOgg = headBytes[0] === 0x4f && headBytes[1] === 0x67 && headBytes[2] === 0x67 && headBytes[3] === 0x53;
    const isMp3OrAdts = headBytes[0] === 0xff && (headBytes[1]! & 0xe0) === 0xe0;
    if (isId3 || isOgg || isMp3OrAdts) {
      return { ok: false, reason: "Lossy audio stream header rejected (FLAC/ALAC only)" };
    }
    // ISO BMFF (`ftyp` at offset 4)
    if (headBytes.length >= 8 && headBytes[4] === 0x66 && headBytes[5] === 0x74 && headBytes[6] === 0x79 && headBytes[7] === 0x70) {
      const ascii = Buffer.from(headBytes).toString("latin1");
      if (ascii.includes("alac")) return { ok: true, codec: "ALAC", mimeType: "audio/mp4", extension: "m4a" };
      if (ascii.includes("mp4a") || ascii.includes("M4A ")) {
        return { ok: false, reason: "Lossy M4A/AAC container rejected (FLAC/ALAC only)" };
      }
    }
  }
  if (m.includes("mp4") || m.includes("alac")) return { ok: true, codec: "ALAC", mimeType: "audio/mp4", extension: "m4a" };
  return { ok: true, codec: "FLAC", mimeType: "audio/flac", extension: "flac" };
}

export function normalizeLosslessMetadata(track: ProviderTrack): ProviderTrack {
  const fmt = track.format?.toLowerCase();
  const codec: "FLAC" | "ALAC" = fmt === "alac" || fmt === "m4a" ? "ALAC" : "FLAC";
  const isHiRes = (track.bitDepth !== undefined && track.bitDepth > 16) || (track.sampleRate !== undefined && track.sampleRate > 48_000);
  return {
    ...track,
    format: track.format ?? (codec === "ALAC" ? "alac" : "flac"),
    codec: track.codec ?? codec,
    lossless: true,
    qualityTier: track.qualityTier ?? (isHiRes ? "HI-RES LOSSLESS" : "LOSSLESS"),
  };
}
