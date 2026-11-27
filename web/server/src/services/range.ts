import type { FastifyReply, FastifyRequest } from "fastify";

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parses a single-range `Range: bytes=…` header against a resource size.
 * Returns `undefined` for "no/ignored range" and `null` for unsatisfiable.
 * Multi-range requests are answered with the full body (allowed by RFC 9110).
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  const [, s, e] = m;
  if (s === "" && e === "") return undefined;
  let start: number;
  let end: number;
  if (s === "") {
    const suffix = Number(e);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(s);
    end = e === "" ? size - 1 : Math.min(Number(e), size - 1);
  }
  if (start >= size || start > end) return null;
  return { start, end };
}

/** Serves an in-memory buffer with full Range support (used by demo mode). */
export function sendBufferWithRange(
  request: FastifyRequest,
  reply: FastifyReply,
  buf: Buffer,
  contentType: string,
): FastifyReply {
  const size = buf.length;
  reply.header("accept-ranges", "bytes").header("content-type", contentType).header("cache-control", "public, max-age=86400");
  const range = parseRange(request.headers.range, size);
  if (range === null) {
    return reply.code(416).header("content-range", `bytes */${size}`).send();
  }
  if (range === undefined) {
    reply.code(200).header("content-length", size);
    return request.method === "HEAD" ? reply.send() : reply.send(buf);
  }
  const { start, end } = range;
  reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1);
  return request.method === "HEAD" ? reply.send() : reply.send(buf.subarray(start, end + 1));
}
