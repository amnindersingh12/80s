/**
 * Pure Node/TypeScript FLAC metadata block writer (RFC 9639).
 * Rewrites only the metadata header blocks (VORBIS_COMMENT + PICTURE) up to the first
 * audio frame without buffering the whole FLAC audio payload into memory.
 */

const BLOCK_STREAMINFO = 0;
const BLOCK_PADDING = 1;
const BLOCK_VORBIS_COMMENT = 4;
const BLOCK_PICTURE = 6;
const MAX_HEADER_BYTES = 4 * 1024 * 1024;

export interface FlacTagInput {
  title: string;
  artist: string;
  album?: string;
  albumArtist?: string;
  year?: number;
  trackNumber?: number;
  isrc?: string;
  lyrics?: string;
  coverBytes?: Uint8Array;
  coverMime?: string;
}

export interface FlacRewritePlan {
  header: Buffer;
  oldHeaderLength: number;
  audioTail: Buffer;
}

export function buildVorbisCommentPayload(tags: FlacTagInput, existingCommentsPayload?: Buffer): Buffer {
  const vendorAndRest = parseVorbisComments(existingCommentsPayload);
  const vendor = vendorAndRest?.vendor ?? "80s-lossless";
  const entries = new Map<string, string>(vendorAndRest?.entries ?? []);

  if (tags.title.trim()) entries.set("TITLE", tags.title.trim());
  if (tags.artist.trim()) entries.set("ARTIST", tags.artist.trim());
  if (tags.album?.trim()) entries.set("ALBUM", tags.album.trim());
  if (tags.albumArtist?.trim()) entries.set("ALBUMARTIST", tags.albumArtist.trim());
  else if (tags.artist.trim() && !entries.has("ALBUMARTIST")) entries.set("ALBUMARTIST", tags.artist.trim());
  if (tags.year && tags.year > 0) entries.set("DATE", String(tags.year));
  if (tags.trackNumber && tags.trackNumber > 0) entries.set("TRACKNUMBER", String(tags.trackNumber));
  if (tags.isrc?.trim()) entries.set("ISRC", tags.isrc.trim());
  if (tags.lyrics?.trim()) {
    entries.set("LYRICS", tags.lyrics.trim());
    entries.set("SYNCEDLYRICS", tags.lyrics.trim());
  }

  const vendorBuf = Buffer.from(vendor, "utf8");
  const commentBufs = [...entries.entries()].map(([k, v]) => Buffer.from(`${k}=${v}`, "utf8"));
  const totalLen =
    4 + vendorBuf.length + 4 + commentBufs.reduce((sum, b) => sum + 4 + b.length, 0);

  const out = Buffer.allocUnsafe(totalLen);
  let off = 0;
  out.writeUInt32LE(vendorBuf.length, off);
  off += 4;
  vendorBuf.copy(out, off);
  off += vendorBuf.length;
  out.writeUInt32LE(commentBufs.length, off);
  off += 4;
  for (const b of commentBufs) {
    out.writeUInt32LE(b.length, off);
    off += 4;
    b.copy(out, off);
    off += b.length;
  }
  return out;
}

export function buildPicturePayload(coverBytes: Uint8Array, mime = "image/jpeg"): Buffer {
  const cleanMime = mime.split(";")[0]?.trim() || "image/jpeg";
  const mimeBuf = Buffer.from(cleanMime, "ascii");
  const out = Buffer.allocUnsafe(4 + 4 + mimeBuf.length + 4 + 16 + 4 + coverBytes.length);
  let off = 0;
  out.writeUInt32BE(3, off); // Picture type 3: Front Cover
  off += 4;
  out.writeUInt32BE(mimeBuf.length, off);
  off += 4;
  mimeBuf.copy(out, off);
  off += mimeBuf.length;
  out.writeUInt32BE(0, off); // Description length
  off += 4;
  out.fill(0, off, off + 16); // width, height, depth, indexed colors (0 = unspecified)
  off += 16;
  out.writeUInt32BE(coverBytes.length, off);
  off += 4;
  Buffer.from(coverBytes).copy(out, off);
  return out;
}

export function parseVorbisComments(
  payload?: Uint8Array,
): { vendor: string; entries: Array<[string, string]> } | undefined {
  if (!payload || payload.length < 8) return undefined;
  const buf = Buffer.from(payload);
  let off = 0;
  const vendorLen = buf.readUInt32LE(off);
  off += 4;
  if (off + vendorLen + 4 > buf.length) return undefined;
  const vendor = buf.subarray(off, off + vendorLen).toString("utf8");
  off += vendorLen;
  const count = buf.readUInt32LE(off);
  off += 4;
  const entries: Array<[string, string]> = [];
  for (let i = 0; i < count; i++) {
    if (off + 4 > buf.length) break;
    const len = buf.readUInt32LE(off);
    off += 4;
    if (off + len > buf.length) break;
    const comment = buf.subarray(off, off + len).toString("utf8");
    off += len;
    const eq = comment.indexOf("=");
    if (eq > 0) entries.push([comment.slice(0, eq).toUpperCase(), comment.slice(eq + 1)]);
  }
  return { vendor, entries };
}

/**
 * Reads just enough chunks from `reader` (+ `initialChunk`) to consume all FLAC metadata blocks
 * up to the first audio frame, then builds a replacement FLAC header containing VORBIS_COMMENT
 * and PICTURE blocks. Returns `null` if input isn't a valid/rewriteable FLAC header.
 */
export async function prepareFlacHeaderRewrite(
  initialChunk: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  tags: FlacTagInput,
): Promise<FlacRewritePlan | null> {
  const chunks: Buffer[] = [Buffer.from(initialChunk)];
  let buffered = Buffer.concat(chunks);

  const ensureBytes = async (needed: number): Promise<boolean> => {
    while (buffered.length < needed) {
      if (buffered.length > MAX_HEADER_BYTES) return false;
      const next = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (next.done || !next.value) return false;
      chunks.push(Buffer.from(next.value));
      buffered = Buffer.concat(chunks);
    }
    return true;
  };

  if (!(await ensureBytes(42))) return null;
  if (buffered.subarray(0, 4).toString("ascii") !== "fLaC") return null;
  // RFC 9639 §4.1: first metadata block must be STREAMINFO (type 0) of exact length 34.
  const firstType = buffered[4]! & 0x7f;
  const firstLen = (buffered[5]! << 16) | (buffered[6]! << 8) | buffered[7]!;
  if (firstType !== BLOCK_STREAMINFO || firstLen !== 34) return null;

  let offset = 4;
  let isLast = false;
  const preserved: Array<{ type: number; payload: Buffer }> = [];
  let existingVorbis: Buffer | undefined;

  while (!isLast) {
    if (!(await ensureBytes(offset + 4))) return null;
    const hdrByte = buffered[offset]!;
    isLast = (hdrByte & 0x80) !== 0;
    const blockType = hdrByte & 0x7f;
    const blockLen = (buffered[offset + 1]! << 16) | (buffered[offset + 2]! << 8) | buffered[offset + 3]!;
    offset += 4;
    if (offset + blockLen > MAX_HEADER_BYTES) return null;
    if (!(await ensureBytes(offset + blockLen))) return null;

    const payload = Buffer.from(buffered.subarray(offset, offset + blockLen));
    offset += blockLen;

    if (blockType === BLOCK_PADDING) continue;
    if (blockType === BLOCK_VORBIS_COMMENT) {
      existingVorbis = payload;
      continue;
    }
    if (blockType === BLOCK_PICTURE && tags.coverBytes && tags.coverBytes.length > 0) {
      continue;
    }
    preserved.push({ type: blockType, payload });
  }

  // Ensure STREAMINFO stays first, then preserved non-comment blocks, then VORBIS_COMMENT, then PICTURE.
  const blocks: Array<{ type: number; payload: Buffer }> = [
    ...preserved.filter((b) => b.type === BLOCK_STREAMINFO),
    ...preserved.filter((b) => b.type !== BLOCK_STREAMINFO),
    { type: BLOCK_VORBIS_COMMENT, payload: buildVorbisCommentPayload(tags, existingVorbis) },
  ];
  if (tags.coverBytes && tags.coverBytes.length > 0) {
    blocks.push({ type: BLOCK_PICTURE, payload: buildPicturePayload(tags.coverBytes, tags.coverMime) });
  }

  const outParts: Buffer[] = [Buffer.from("fLaC", "ascii")];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    const last = i === blocks.length - 1 ? 0x80 : 0;
    const hdr = Buffer.allocUnsafe(4);
    hdr[0] = last | (b.type & 0x7f);
    hdr[1] = (b.payload.length >>> 16) & 0xff;
    hdr[2] = (b.payload.length >>> 8) & 0xff;
    hdr[3] = b.payload.length & 0xff;
    outParts.push(hdr, b.payload);
  }

  return {
    header: Buffer.concat(outParts),
    oldHeaderLength: offset,
    audioTail: Buffer.from(buffered.subarray(offset)),
  };
}
