import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../errors.js";
import type { CacheStore } from "../lib/cache.js";
import { prepareFlacHeaderRewrite, type FlacTagInput } from "../lib/flacTags.js";
import type { FetchFn } from "../lib/http.js";
import { enrichTrackMetadata } from "../lib/metadataEnricher.js";
import { contentDisposition, safeFilename } from "../lib/text.js";
import { parsePublicId, type ProviderChain, type ResolvedStream } from "../providers/chain.js";
import { MIME_BY_EXTENSION, extensionForMime, verifyLosslessStream } from "../providers/types.js";
import { fetchLyrics } from "./lyrics.js";
import type { PrepareTracker } from "./prepare.js";

export interface StreamProxyDeps {
  chain: ProviderChain;
  tracker: PrepareTracker;
  cache?: CacheStore;
  fetch?: FetchFn;
  /** Max wait for the CDN to send response headers. */
  headerTimeoutMs: number;
  /** Skip external iTunes/LRCLIB lookups during download (e.g. demo/unit tests). */
  skipEnrich?: boolean;
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
    reply.raw.off("close", onClose);
    throw new AppError("STREAM_UNAVAILABLE", `The audio host answered HTTP ${res.status}`, {
      upstreamStatus: res.status,
      provider: resolved.servedBy.name,
    });
  }

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

  if (isHead) {
    await res.body?.cancel().catch(() => undefined);
    reply.raw.off("close", onClose);
    reply.code(res.status);
    for (const name of PASSTHROUGH_HEADERS) {
      const v = res.headers.get(name);
      if (v !== null) reply.header(name, v);
    }
    reply
      .header("content-type", contentType)
      .header("cache-control", "private, max-age=3600, no-transform")
      .header("x-content-type-options", "nosniff")
      .header("x-served-by", resolved.servedBy.name);
    const total = totalFromContentRange(res.headers.get("content-range"));
    if (res.status === 206) {
      reply.code(200).removeHeader("content-range");
      if (total !== undefined) reply.header("content-length", total);
      else reply.removeHeader("content-length");
      reply.header("accept-ranges", "bytes");
    }
    return reply.send();
  }

  // Peek first chunk on start-of-file streams to block masked lossy payloads BEFORE sending headers.
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let firstChunk: Uint8Array | undefined;
  if (res.body) {
    reader = res.body.getReader();
    const firstRead = await reader.read().catch(() => ({ done: true as const, value: undefined }));
    firstChunk = firstRead.value;
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
  }

  let headChunk = firstChunk;
  let injectedHeader: Buffer | undefined;
  let contentLengthOverride: number | undefined;
  let metaTitleArtist: { artist?: string; title?: string } | undefined;

  const looksLikeGenuineFlac =
    Boolean(headChunk) &&
    headChunk!.length >= 8 &&
    headChunk![0] === 0x66 &&
    headChunk![1] === 0x4c &&
    headChunk![2] === 0x61 &&
    headChunk![3] === 0x43 &&
    (headChunk![4]! & 0x7f) === 0 &&
    ((headChunk![5]! << 16) | (headChunk![6]! << 8) | headChunk![7]!) === 34;

  if (mode === "download" && !rangeHeader && reader && headChunk && looksLikeGenuineFlac) {
    const fetchFn = deps.fetch ?? fetch;
    const rawTrack = await deps.chain.getTrack(id).catch(() => null);
    const enriched =
      rawTrack && deps.cache && !deps.skipEnrich
        ? await enrichTrackMetadata(rawTrack, deps.cache, fetchFn).catch(() => rawTrack)
        : rawTrack;
    const tagTitle = enriched?.title ?? request.query.title?.slice(0, 200) ?? "";
    const tagArtist = enriched?.artist ?? request.query.artist?.slice(0, 200) ?? "";
    metaTitleArtist = { artist: tagArtist || undefined, title: tagTitle || undefined };

    const [lyricsRes, coverRes] = await Promise.all([
      !deps.skipEnrich && tagTitle && tagArtist
        ? fetchLyrics(
            { track: tagTitle, artist: tagArtist, album: enriched?.album, durationSec: enriched?.durationSec },
            { fetch: fetchFn },
          ).catch(() => null)
        : Promise.resolve(null),
      !deps.skipEnrich && enriched?.coverUrl
        ? fetchCoverAsset(enriched.coverUrl, fetchFn, clientGone.signal).catch(() => null)
        : Promise.resolve(null),
    ]);

    const tags: FlacTagInput = {
      title: tagTitle,
      artist: tagArtist,
      ...(enriched?.album ? { album: enriched.album } : {}),
      ...(enriched?.albumArtist ? { albumArtist: enriched.albumArtist } : {}),
      ...(enriched?.year ? { year: enriched.year } : {}),
      ...(enriched?.trackNumber ? { trackNumber: enriched.trackNumber } : {}),
      ...(enriched?.isrc ? { isrc: enriched.isrc } : {}),
      ...(lyricsRes?.syncedLyrics || lyricsRes?.plainLyrics
        ? { lyrics: (lyricsRes.syncedLyrics ?? lyricsRes.plainLyrics) as string }
        : {}),
      ...(coverRes ? { coverBytes: coverRes.bytes, coverMime: coverRes.mime } : {}),
    };

    if (tags.title || tags.artist || tags.lyrics || tags.coverBytes) {
      const plan = await prepareFlacHeaderRewrite(headChunk, reader, tags);
      if (plan) {
        injectedHeader = plan.header;
        headChunk = plan.audioTail;
        const origLen = Number(res.headers.get("content-length"));
        if (Number.isFinite(origLen) && origLen > 0) {
          contentLengthOverride = origLen - plan.oldHeaderLength + plan.header.length;
        }
      }
    }
  }

  reply.code(res.status);
  for (const name of PASSTHROUGH_HEADERS) {
    const v = res.headers.get(name);
    if (v !== null) reply.header(name, v);
  }
  if (contentLengthOverride !== undefined) reply.header("content-length", contentLengthOverride);
  if (res.status === 206 && !res.headers.has("accept-ranges")) reply.header("accept-ranges", "bytes");
  reply
    .header("content-type", contentType)
    .header("cache-control", "private, max-age=3600, no-transform")
    .header("x-content-type-options", "nosniff")
    .header("x-served-by", resolved.servedBy.name);

  if (mode === "download") {
    reply.header("content-disposition", contentDisposition(await downloadName(deps.chain, id, ext, metaTitleArtist ?? request.query)));
  }

  if (!res.body || !reader) {
    reply.raw.off("close", onClose);
    return reply.send();
  }

  const activeReader = reader;
  const headerToSend = injectedHeader;
  const tailToSend = headChunk;
  async function* chunkStream() {
    if (headerToSend && headerToSend.length > 0) yield headerToSend;
    if (tailToSend && tailToSend.length > 0) yield tailToSend;
    try {
      while (true) {
        const { done, value } = await activeReader.read();
        if (done) break;
        if (value) yield value;
      }
    } finally {
      activeReader.releaseLock();
    }
  }

  const body = Readable.from(chunkStream());
  // If the browser hangs up mid-transfer, stop pulling bytes from the CDN.
  clientGone.signal.addEventListener("abort", () => {
    activeReader.cancel().catch(() => undefined);
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
  const track = hints.artist && hints.title ? null : await chain.getTrack(id).catch(() => null);
  const artist = hints.artist?.slice(0, 200) ?? track?.artist;
  const title = hints.title?.slice(0, 200) ?? track?.title;
  const base = artist && title ? `${artist} - ${title}` : (title ?? `track-${parsePublicId(id).rawId}`);
  return safeFilename(base, ext);
}

async function fetchCoverAsset(
  url: string,
  fetchFn: FetchFn,
  parentSignal: AbortSignal,
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_500);
  try {
    const res = await fetchFn(url, { signal: AbortSignal.any([parentSignal, controller.signal]) });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > 2_000_000) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 2_000_000) return null;
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
    return { bytes, mime };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
