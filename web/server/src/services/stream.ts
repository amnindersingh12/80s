import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import type { FetchFn } from "../lib/http.js";
import { contentDisposition, safeFilename } from "../lib/text.js";
import { parsePublicId, type ProviderChain, type ResolvedStream } from "../providers/chain.js";
import { MIME_BY_EXTENSION, extensionForMime, verifyLosslessStream } from "../providers/types.js";
import type { PrepareTracker } from "./prepare.js";

export interface StreamProxyDeps {
  chain: ProviderChain;
  tracker: PrepareTracker;
  fetch?: FetchFn;
  /** Max wait for the CDN to send response headers. */
  headerTimeoutMs: number;
}

/** Upstream headers forwarded verbatim so browser seeking and caching work. */
const PASSTHROUGH_HEADERS = ["content-length", "content-range", "accept-ranges", "etag", "last-modified"] as const;
const GENERIC_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream", "application/x-download", "application/force-download"]);
/** Statuses that usually mean the signed URL expired or that instance needs failover: re-resolve once. */
const STALE_URL_STATUSES = new Set([401, 403, 404, 410, 429, 500, 502, 503, 504]);

class HeaderTimeout extends Error {}
class ClientGone extends Error {}

interface Upstream {
  res: Response;
  resolved: ResolvedStream;
}

/**
 * Pass-through audio proxy. The browser only ever sees `/api/stream/:id`;
 * signed R2/CDN URLs and provider credentials stay on the server.
 *
 * - forwards `Range` / `If-Range` upstream and `Content-Range`,
 *   `Accept-Ranges`, `Content-Length`, `ETag`, `Last-Modified` back, so
 *   `<audio>` can seek with 206 responses;
 * - answers `HEAD` with a 1-byte ranged GET (presigned URLs are GET-only);
 * - aborts the upstream request as soon as the browser hangs up (seeks
 *   cancel the previous range request constantly);
 * - if the cached signed URL was rejected (expired), resolves a fresh one once.
 */
export async function proxyAudio(
  request: FastifyRequest<{ Params: { id: string }; Querystring: { artist?: string; title?: string } }>,
  reply: FastifyReply,
  deps: StreamProxyDeps,
  mode: "stream" | "download",
): Promise<FastifyReply> {
  const id = request.params.id;
  const isHead = request.method === "HEAD";
  const rangeHeader = typeof request.headers.range === "string" && request.headers.range.startsWith("bytes=")
    ? request.headers.range
    : undefined;
  const upstreamRange = isHead ? "bytes=0-0" : rangeHeader;

  if (isHead) {
    const resolved = await deps.tracker.ensure(id);
    if (resolved.source.contentLength !== undefined) {
      const ext = resolved.source.extension ?? "flac";
      const contentType = resolved.source.mimeType ?? MIME_BY_EXTENSION[ext] ?? "audio/flac";
      return reply
        .code(200)
        .header("content-type", contentType)
        .header("content-length", resolved.source.contentLength)
        .header("accept-ranges", "bytes")
        .header("cache-control", "private, max-age=3600, no-transform")
        .header("x-content-type-options", "nosniff")
        .header("x-served-by", resolved.servedBy.name)
        .send();
    }
  }

  const clientGone = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableFinished) clientGone.abort(new ClientGone());
  };
  reply.raw.once("close", onClose);

  let up: Upstream;
  try {
    up = await openUpstream(request, deps, id, upstreamRange, clientGone.signal);
  } catch (err) {
    reply.raw.off("close", onClose);
    if (clientGone.signal.aborted) return reply; // nobody to answer
    throw err;
  }
  const { res, resolved } = up;

  if (!res.ok && res.status !== 416) {
    await res.body?.cancel().catch(() => undefined);
    throw new AppError("STREAM_UNAVAILABLE", `The audio host answered HTTP ${res.status}`, {
      upstreamStatus: res.status,
      provider: resolved.servedBy.name,
    });
  }

  reply.code(res.status);
  for (const name of PASSTHROUGH_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null) reply.header(name, v);
  }
  if (res.status === 206 && !res.headers.has("accept-ranges")) reply.header("accept-ranges", "bytes");

  const upstreamType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const losslessCheck = verifyLosslessStream(upstreamType);
  if (!losslessCheck.ok) {
    await res.body?.cancel().catch(() => undefined);
    reply.raw.off("close", onClose);
    throw new AppError("STREAM_UNAVAILABLE", losslessCheck.reason ?? "Only lossless FLAC/ALAC streams are supported", {
      provider: resolved.servedBy.name,
    });
  }
  const ext = resolved.source.extension ?? extensionForMime(upstreamType) ?? "flac";
  const contentType = GENERIC_TYPES.has(upstreamType)
    ? (resolved.source.mimeType ?? MIME_BY_EXTENSION[ext] ?? "audio/flac")
    : (res.headers.get("content-type") as string);
  reply
    .header("content-type", contentType)
    .header("cache-control", "private, max-age=3600, no-transform")
    .header("x-content-type-options", "nosniff")
    .header("x-served-by", resolved.servedBy.name);

  if (mode === "download") {
    reply.header("content-disposition", contentDisposition(await downloadName(deps.chain, id, ext, request.query)));
  }

  if (isHead) {
    await res.body?.cancel().catch(() => undefined);
    reply.raw.off("close", onClose);
    const total = totalFromContentRange(res.headers.get("content-range"));
    if (res.status === 206) {
      reply.code(200).removeHeader("content-range");
      if (total !== undefined) reply.header("content-length", total);
      else reply.removeHeader("content-length");
      reply.header("accept-ranges", "bytes");
    }
    return reply.send();
  }

  if (!res.body) {
    reply.raw.off("close", onClose);
    return reply.send();
  }

  // Peek first chunk on start-of-file streams to block masked lossy payloads (e.g. MP3 sent as audio/flac).
  const reader = res.body.getReader();
  const firstRead = await reader.read().catch(() => ({ done: true as const, value: undefined }));
  const firstChunk = firstRead.value;
  if (firstChunk && (!rangeHeader || rangeHeader.startsWith("bytes=0-"))) {
    const magicCheck = verifyLosslessStream(upstreamType, firstChunk);
    if (!magicCheck.ok) {
      await reader.cancel().catch(() => undefined);
      reply.raw.off("close", onClose);
      throw new AppError("STREAM_UNAVAILABLE", magicCheck.reason ?? "Only lossless FLAC/ALAC streams are supported", {
        provider: resolved.servedBy.name,
      });
    }
  }

  async function* chunkStream() {
    if (firstChunk) yield firstChunk;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }

  const body = Readable.from(chunkStream());
  // If the browser hangs up mid-transfer, stop pulling bytes from the CDN.
  clientGone.signal.addEventListener("abort", () => {
    reader.cancel().catch(() => undefined);
    body.destroy();
  }, { once: true });
  body.on("error", () => undefined);
  body.once("close", () => reply.raw.off("close", onClose));
  return reply.send(body);
}

async function openUpstream(
  request: FastifyRequest,
  deps: StreamProxyDeps,
  id: string,
  range: string | undefined,
  clientGone: AbortSignal,
): Promise<Upstream> {
  let resolved = await deps.tracker.ensure(id);
  let res: Response;
  try {
    res = await fetchSource(request, deps, resolved, range, clientGone);
  } catch (err) {
    if (clientGone.aborted || !(err instanceof AppError) || (err.code !== "UPSTREAM_TIMEOUT" && err.code !== "UPSTREAM_UNAVAILABLE")) {
      throw err;
    }
    await deps.chain.invalidateStream(resolved);
    resolved = await deps.tracker.ensure(id);
    res = await fetchSource(request, deps, resolved, range, clientGone);
  }
  if (STALE_URL_STATUSES.has(res.status)) {
    await res.body?.cancel().catch(() => undefined);
    await deps.chain.invalidateStream(resolved);
    resolved = await deps.tracker.ensure(id);
    res = await fetchSource(request, deps, resolved, range, clientGone);
  }
  return { res, resolved };
}

async function fetchSource(
  request: FastifyRequest,
  deps: StreamProxyDeps,
  resolved: ResolvedStream,
  range: string | undefined,
  clientGone: AbortSignal,
): Promise<Response> {
  const { source, servedBy } = resolved;
  const headers: Record<string, string> = {
    "accept-encoding": "identity",
    ...(await servedBy.authorizeStream(source)),
    ...(source.headers ?? {}),
  };
  if (range) headers.range = range;
  const ifRange = request.headers["if-range"];
  if (range && typeof ifRange === "string") headers["if-range"] = ifRange;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new HeaderTimeout()), deps.headerTimeoutMs);
  const onGone = () => controller.abort(clientGone.reason);
  clientGone.addEventListener("abort", onGone, { once: true });
  try {
    return await (deps.fetch ?? fetch)(source.url, { headers, signal: controller.signal, redirect: "follow" });
  } catch (cause) {
    if (controller.signal.reason instanceof HeaderTimeout) {
      throw new AppError("UPSTREAM_TIMEOUT", `The audio host did not respond within ${deps.headerTimeoutMs} ms`, {
        provider: servedBy.name,
      });
    }
    if (clientGone.aborted) throw cause;
    throw new AppError("UPSTREAM_UNAVAILABLE", "The audio host is unreachable", { provider: servedBy.name, cause });
  } finally {
    clearTimeout(timer);
    // Keep the client-gone listener wired to the controller for the body phase.
    if (!clientGone.aborted) {
      clientGone.removeEventListener("abort", onGone);
      clientGone.addEventListener("abort", () => controller.abort(clientGone.reason), { once: true });
    }
  }
}

function totalFromContentRange(value: string | null): number | undefined {
  const m = value?.match(/\/(\d+)\s*$/);
  return m ? Number(m[1]) : undefined;
}

async function downloadName(
  chain: ProviderChain,
  id: string,
  ext: string,
  hints: { artist?: string; title?: string },
): Promise<string> {
  const track = await chain.getTrack(id).catch(() => null);
  const artist = track?.artist ?? hints.artist?.slice(0, 200);
  const title = track?.title ?? hints.title?.slice(0, 200);
  const base = artist && title ? `${artist} - ${title}` : (title ?? `track-${parsePublicId(id).rawId}`);
  return safeFilename(base, ext);
}
