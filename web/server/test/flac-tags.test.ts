import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseVorbisComments, prepareFlacHeaderRewrite } from "../src/lib/flacTags.js";
import { verifyLosslessStream } from "../src/providers/types.js";

function buildMinimalFlac(audioFrames: Buffer): Buffer {
  const streamInfo = Buffer.alloc(34, 0);
  // 44.1 kHz / 2ch / 16-bit
  streamInfo[10] = 0x0a;
  streamInfo[11] = 0xc4;
  streamInfo[12] = 0x42;
  streamInfo[13] = 0xf0;
  const hdr = Buffer.from([0x80, 0x00, 0x00, 34]); // isLast=1, type=0 (STREAMINFO), len=34
  return Buffer.concat([Buffer.from("fLaC", "ascii"), hdr, streamInfo, audioFrames]);
}

function readBlocks(buf: Buffer): Array<{ type: number; payload: Buffer; isLast: boolean; nextOffset: number }> {
  expect(buf.subarray(0, 4).toString("ascii")).toBe("fLaC");
  let off = 4;
  const out: Array<{ type: number; payload: Buffer; isLast: boolean; nextOffset: number }> = [];
  let isLast = false;
  while (!isLast) {
    const b0 = buf[off]!;
    isLast = (b0 & 0x80) !== 0;
    const type = b0 & 0x7f;
    const len = (buf[off + 1]! << 16) | (buf[off + 2]! << 8) | buf[off + 3]!;
    off += 4;
    const payload = buf.subarray(off, off + len);
    off += len;
    out.push({ type, payload, isLast, nextOffset: off });
  }
  return out;
}

describe("FLAC VORBIS_COMMENT + PICTURE header injection", () => {
  it("injects tags, lyrics, and cover art cleanly while preserving STREAMINFO and audio bytes", async () => {
    const audioFrames = Buffer.from([0xff, 0xf8, 0x01, 0x02, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef]);
    const original = buildMinimalFlac(audioFrames);
    const webStream = Readable.toWeb(Readable.from([original.subarray(0, 12), original.subarray(12)])) as unknown as ReadableStream<Uint8Array>;
    const reader = webStream.getReader();
    const first = (await reader.read()).value!;
    const coverBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22]);

    const plan = await prepareFlacHeaderRewrite(first, reader, {
      title: "Karma Police",
      artist: "Radiohead",
      album: "OK Computer",
      albumArtist: "Radiohead",
      year: 1997,
      trackNumber: 6,
      lyrics: "[00:26.78]Karma police",
      coverBytes,
      coverMime: "image/jpeg",
    });
    expect(plan).not.toBeNull();
    const rebuilt = Buffer.concat([plan!.header, plan!.audioTail]);
    const blocks = readBlocks(rebuilt);
    expect(blocks.map((b) => b.type)).toEqual([0, 4, 6]); // STREAMINFO, VORBIS_COMMENT, PICTURE
    expect(blocks.at(-1)!.isLast).toBe(true);
    expect(rebuilt.subarray(blocks.at(-1)!.nextOffset).equals(audioFrames)).toBe(true);

    const parsed = parseVorbisComments(blocks[1]!.payload);
    expect(Object.fromEntries(parsed!.entries)).toMatchObject({
      TITLE: "Karma Police",
      ARTIST: "Radiohead",
      ALBUM: "OK Computer",
      ALBUMARTIST: "Radiohead",
      DATE: "1997",
      TRACKNUMBER: "6",
      LYRICS: "[00:26.78]Karma police",
    });

    // PICTURE type 3 (Front Cover) + JPEG magic bytes present inside payload
    expect(blocks[2]!.payload.readUInt32BE(0)).toBe(3);
    expect(blocks[2]!.payload.includes(Buffer.from(coverBytes))).toBe(true);
  });

  it("rejects non-audio HTML / JSON responses in verifyLosslessStream", () => {
    expect(verifyLosslessStream("text/html", Buffer.from("<html>error</html>")).ok).toBe(false);
    expect(verifyLosslessStream("application/octet-stream", Buffer.from("{}")).ok).toBe(false);
    expect(verifyLosslessStream("audio/flac", Buffer.alloc(0)).ok).toBe(false);
  });
});
