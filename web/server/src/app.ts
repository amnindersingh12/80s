import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import fastifyStatic from "@fastify/static";
import type {
  AlbumDetailResponse,
  ArtistDetailResponse,
  DoctorResponse,
  ErrorCode,
  HealthResponse,
  HomeResponse,
  PrepareStatus,
  RadioRequest,
  RecommendationSeed,
  ResolveTrackRequest,
  ResolveTrackResponse,
  SearchFilterType,
  SearchResponse,
  SeedType,
} from "../../shared/api.js";
import type { Config, Env } from "./config.js";
import { runDoctor } from "./doctor.js";
import type { DiscoveryResult } from "./lib/discovery.js";
import { AppError, isAppError, toAppError } from "./errors.js";
import { sleep } from "./lib/http.js";
import { bestMatch, normalizeText } from "./lib/text.js";
import { deriveAlbumsFromTracks } from "./providers/chain.js";
import { renderDemoCover } from "./providers/mock.js";
import type { AppServices } from "./services.js";
import { enrichTrackList, enrichTrackMetadata } from "./lib/metadataEnricher.js";
import { buildSignedStreamUrl, verifyStreamToken } from "./lib/streamToken.js";
import { fetchLyrics } from "./services/lyrics.js";
import { proxyAudio } from "./services/stream.js";

export const SESSION_COOKIE = "eighties_session";

export interface BuildAppOptions {
  config: Config;
  services: AppServices;
  logger?: FastifyServerOptions["logger"];
  /** Raw environment for `/api/doctor` (default `process.env`). */
  env?: Env;
  /** fetch used by `/api/doctor` (tests). */
  doctorFetch?: typeof fetch;
  /** Media-config problems found at boot (server then runs in safe demo mode). */
  configErrors?: string[];
  /** Startup MEDIA_FRONTEND_URL discovery, reused by health and `/api/doctor`. */
  discovery?: { result: DiscoveryResult; filled: string[] };
}

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", minLength: 3, maxLength: 512 } },
} as const;

const nameHints = {
  type: "object",
  properties: { artist: { type: "string", maxLength: 200 }, title: { type: "string", maxLength: 200 } },
} as const;

const seedProps = {
  type: { type: "string", enum: ["track", "artist", "tag"] },
  trackId: { type: "string", maxLength: 512 },
  artist: { type: "string", maxLength: 200 },
  title: { type: "string", maxLength: 300 },
  tag: { type: "string", maxLength: 100 },
} as const;

export async function buildApp({ config, services, logger = false, env = process.env, doctorFetch, discovery, configErrors = [] }: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      logger === true
        ? {
            level: config.logLevel,
            redact: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-access-key"]'],
          }
        : logger,
    trustProxy: config.trustProxy,
    routerOptions: { maxParamLength: 600 },
    bodyLimit: 64 * 1024,
  });

  const { chain, tracker, engine } = services;

  // ------------------------------------------------------------ errors ---
  app.setErrorHandler((err: unknown, request, reply) => {
    const validation = (err as { validation?: unknown; message?: string }).validation;
    if (validation) {
      return reply.code(400).send(new AppError("BAD_REQUEST", (err as Error).message).toBody());
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (!isAppError(err) && statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send(new AppError("BAD_REQUEST", (err as Error).message).toBody());
    }
    const appErr = toAppError(err);
    if (appErr.status >= 500) {
      request.log.warn({ code: appErr.code, provider: appErr.provider, upstreamStatus: appErr.upstreamStatus, msg: appErr.message, cause: isAppError(err) ? undefined : err }, "request failed");
    }
    if (reply.sent || reply.raw.headersSent) return;
    return reply.code(appErr.status).send(appErr.toBody());
  });

  // ---------------------------------------------------- security headers ---
  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    if (!request.url.startsWith("/api/")) {
      reply.header(
        "content-security-policy",
        "default-src 'self'; img-src 'self' https: data:; media-src 'self' data: blob:; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
    }
    return payload;
  });

  // ------------------------------------------------------- access gate ---
  const accessKey = config.accessKey;
  const sessionValue = accessKey ? createHmac("sha256", accessKey).update("80s-session-v1").digest("base64url") : undefined;
  const isAuthenticated = (request: FastifyRequest): boolean => {
    if (!accessKey || !sessionValue) return true;
    const header = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? request.headers["x-access-key"];
    if (typeof header === "string" && safeEqual(header, accessKey)) return true;
    const cookie = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    return cookie !== undefined && safeEqual(cookie, sessionValue);
  };
  if (accessKey) {
    app.addHook("onRequest", async (request) => {
      const path = request.url.split("?")[0] ?? "";
      if (!path.startsWith("/api/") || path === "/api/health" || path === "/api/session") return;
      if ((request.method === "GET" || request.method === "HEAD") && path.startsWith("/api/stream/")) {
        const rawSeg = path.slice("/api/stream/".length);
        if (rawSeg.length > 0 && !rawSeg.includes("/")) {
          const st = new URLSearchParams(request.url.split("?")[1] ?? "").get("st");
          if (st) {
            try {
              const id = decodeURIComponent(rawSeg);
              if (verifyStreamToken(id, st, accessKey)) return;
            } catch {
              /* malformed encoding falls through to normal auth check */
            }
          }
        }
      }
      if (!isAuthenticated(request)) throw new AppError("ACCESS_REQUIRED", "Unlock the player with the access key first");
    });
  }

  app.post<{ Body: { key: string } }>(
    "/api/session",
    { schema: { body: { type: "object", required: ["key"], properties: { key: { type: "string", maxLength: 512 } } } } },
    async (request, reply) => {
      if (!accessKey || !sessionValue) return { ok: true, accessRequired: false };
      if (!safeEqual(request.body.key, accessKey)) {
        await sleep(400); // blunt online guessing
        throw new AppError("ACCESS_REQUIRED", "Wrong access key");
      }
      const secure = request.protocol === "https" ? "; Secure" : "";
      reply.header("set-cookie", `${SESSION_COOKIE}=${sessionValue}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${secure}`);
      return { ok: true, accessRequired: true };
    },
  );
  app.delete("/api/session", async (_request, reply) => {
    reply.header("set-cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });

  // ------------------------------------------------------------ health ---
  app.get("/api/health", async (request): Promise<HealthResponse> => ({
    ok: true,
    demo: Boolean(services.demo),
    providers: chain.health(),
    recommendations: engine.enabledSources,
    cache: services.cache.kind,
    mediaAuth: config.remote?.authMode ?? null,
    configErrors,
    // off: no MEDIA_FRONTEND_URL (or every value was set explicitly) · failed: page unreachable ·
    // partial: some values not found in the frontend code
    discovery: !discovery
      ? "off"
      : discovery.result.scanned.length === 0
        ? "failed"
        : discovery.result.supabaseUrl && discovery.result.anonKey && discovery.result.apiBaseSource === "code"
          ? "ok"
          : "partial",
    accessRequired: Boolean(accessKey),
    authenticated: isAuthenticated(request),
  }));

  // ------------------------------------------------------------ doctor ---
  // Same checks as `npm run doctor`, for phones without a shell. Only available with
  // APP_ACCESS_KEY set (the gate above then requires it); one run at a time, short-cached,
  // per-request timeouts kept low so the whole run stays under Heroku's 30 s router limit.
  let doctorRun: Promise<DoctorResponse> | undefined;
  let doctorCache: { at: number; value: DoctorResponse } | undefined;
  app.get<{ Querystring: { q?: string } }>(
    "/api/doctor",
    { schema: { querystring: { type: "object", properties: { q: { type: "string", maxLength: 100 } } } } },
    async (request, reply): Promise<DoctorResponse> => {
      if (!accessKey) throw new AppError("NOT_CONFIGURED", "Set APP_ACCESS_KEY to enable /api/doctor");
      reply.header("cache-control", "no-store");
      const query = request.query.q?.trim() ?? "";
      if (!query && doctorCache && Date.now() - doctorCache.at < 10_000) return doctorCache.value;
      doctorRun ??= (async () => {
        const started = Date.now();
        const lines: string[] = [];
        try {
          const result = await runDoctor({ env, query, fetch: doctorFetch, timeoutMs: 6_000, discovery: discovery?.result, log: (l) => lines.push(l) });
          const value: DoctorResponse = { ok: result.ok, steps: result.steps, lines, ranAt: new Date(started).toISOString(), durationMs: Date.now() - started };
          doctorCache = { at: Date.now(), value };
          return value;
        } finally {
          doctorRun = undefined;
        }
      })();
      return doctorRun;
    },
  );

  // ------------------------------------------------------------ search ---
  app.get<{ Querystring: { q: string; type?: SearchFilterType; limit: number } }>(
    "/api/search",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["q"],
          properties: {
            q: { type: "string", minLength: 1, maxLength: 200 },
            type: { type: "string", enum: ["all", "tracks", "artists", "albums"], default: "all" },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 25 },
          },
        },
      },
    },
    async (request): Promise<SearchResponse> => {
      const q = request.query.q.trim();
      if (!q) throw new AppError("BAD_REQUEST", "Query must not be blank");
      const filterType = request.query.type ?? "all";
      const result = await chain.searchCatalog(q, { limit: request.query.limit, type: filterType });
      const tracks = result.tracks.length
        ? await enrichTrackList(result.tracks, services.cache, services.streamFetch, services.demo ? 0 : 8)
        : [];
      return {
        query: q,
        type: filterType,
        ...(result.topResult ? { topResult: result.topResult.kind === "track" && tracks[0] ? { kind: "track", item: tracks[0] } : result.topResult } : {}),
        tracks,
        artists: result.artists,
        albums: result.albums,
        provider: result.provider,
        fallback: result.fallback,
        cached: result.cached,
      };
    },
  );

  // ---------------------------------------------------- artists & albums ---
  const DETAIL_CACHE_TTL_MS = 30 * 60_000;

  async function resolveArtistDetail(rawId: string, fallbackName?: string): Promise<ArtistDetailResponse> {
    const id = rawId.trim();
    const hintName = fallbackName?.trim() || (id.startsWith("name:") ? decodeURIComponent(id.slice(5)) : undefined);
    const cacheKey = `artistdetail:v1:${id}:${normalizeText(hintName ?? "")}`;
    const cached = await services.cache.get<ArtistDetailResponse>(cacheKey);
    if (cached) return cached;

    let artist = id && id !== "lookup" ? await chain.getArtist(id) : null;
    const artistName = artist?.name ?? hintName ?? (id && !id.includes(":") && id !== "lookup" ? id : undefined);
    if (!artistName) throw new AppError("NOT_FOUND", "Artist not found");

    const [catalog, rec] = await Promise.all([
      !artist || !artist.topTracks.length
        ? chain.searchCatalog(artistName, { limit: 20, type: "all" }).catch(() => null)
        : Promise.resolve(null),
      engine.recommend({ type: "artist", artist: artistName }, { limit: 15 }).catch(() => null),
    ]);

    const rawTopTracks = artist?.topTracks.length ? artist.topTracks : (catalog?.tracks ?? []);
    const topTracks = rawTopTracks.length
      ? await enrichTrackList(rawTopTracks.slice(0, 20), services.cache, services.streamFetch, services.demo ? 0 : 6)
      : [];
    const albums = artist?.albums.length
      ? artist.albums
      : catalog?.albums.length
        ? catalog.albums
        : deriveAlbumsFromTracks(topTracks);
    const similarArtists =
      artist?.similarArtists?.length
        ? artist.similarArtists
        : (rec?.similarArtists ?? []);
    const matchedCatalogArtist = catalog?.artists.find((a) => normalizeText(a.name) === normalizeText(artistName)) ?? catalog?.artists[0];
    const imageUrl = artist?.imageUrl ?? matchedCatalogArtist?.imageUrl ?? similarArtists.find((s) => s.imageUrl)?.imageUrl ?? topTracks[0]?.coverUrl;
    const genres = [...new Set([...(artist?.genres ?? []), ...(rec?.tags ?? [])])].slice(0, 8);

    const detail: ArtistDetailResponse = {
      id: artist?.id ?? matchedCatalogArtist?.id ?? id,
      name: artist?.name ?? matchedCatalogArtist?.name ?? artistName,
      ...(imageUrl ? { imageUrl } : {}),
      ...(artist?.bio ? { bio: artist.bio } : {}),
      genres,
      topTracks,
      albums,
      similarArtists,
    };
    await services.cache.set(cacheKey, detail, DETAIL_CACHE_TTL_MS);
    return detail;
  }

  app.get<{ Querystring: { name?: string } }>("/api/artists", async (request): Promise<ArtistDetailResponse> => {
    const name = request.query.name?.trim();
    if (!name) throw new AppError("BAD_REQUEST", "Provide artist ?name=...");
    return resolveArtistDetail(`name:${encodeURIComponent(name)}`, name);
  });

  app.get<{ Params: { id: string }; Querystring: { name?: string } }>(
    "/api/artists/:id",
    { schema: { params: idParams } },
    async (request): Promise<ArtistDetailResponse> => resolveArtistDetail(request.params.id, request.query.name),
  );

  app.get<{ Params: { id: string }; Querystring: { title?: string; artist?: string } }>(
    "/api/albums/:id",
    { schema: { params: idParams } },
    async (request): Promise<AlbumDetailResponse> => {
      const id = request.params.id.trim();
      let hintArtist = request.query.artist?.trim();
      let hintTitle = request.query.title?.trim();
      if (id.startsWith("alb:") && id.includes("|")) {
        const [a, ...rest] = id.slice(4).split("|");
        hintArtist = hintArtist ?? decodeURIComponent(a ?? "");
        hintTitle = hintTitle ?? decodeURIComponent(rest.join("|"));
      }
      const cacheKey = `albumdetail:v1:${id}:${normalizeText(hintArtist ?? "")}:${normalizeText(hintTitle ?? "")}`;
      const cached = await services.cache.get<AlbumDetailResponse>(cacheKey);
      if (cached) return cached;

      let album = await chain.getAlbum(id);
      if (!album && (hintTitle || hintArtist)) {
        const q = [hintArtist, hintTitle].filter(Boolean).join(" ").trim();
        const catalog = await chain.searchCatalog(q, { limit: 25, type: "tracks" });
        const matched = catalog.tracks.filter(
          (t) => !hintTitle || normalizeText(t.album ?? "") === normalizeText(hintTitle) || normalizeText(t.title).includes(normalizeText(hintTitle)),
        );
        const list = (matched.length ? matched : catalog.tracks).slice(0, 20);
        if (list.length) {
          const ordered = [...list].sort((a, b) => (a.trackNumber ?? 9999) - (b.trackNumber ?? 9999));
          const totalDurationMs = ordered.reduce((s, t) => s + (t.durationMs ?? (t.durationSec ?? 0) * 1000), 0);
          album = {
            id,
            title: hintTitle ?? ordered[0]?.album ?? q,
            artist: hintArtist ?? ordered[0]?.albumArtist ?? ordered[0]?.artist ?? "Unknown artist",
            ...(ordered[0]?.artistId ? { artistId: ordered[0].artistId } : {}),
            ...(ordered[0]?.coverUrl ? { coverUrl: ordered[0].coverUrl } : {}),
            ...(ordered[0]?.year ? { year: ordered[0].year } : {}),
            trackCount: ordered.length,
            totalDurationMs,
            codec: ordered[0]?.codec ?? "FLAC",
            ...(ordered[0]?.bitDepth ? { bitDepth: ordered[0].bitDepth } : {}),
            ...(ordered[0]?.sampleRate ? { sampleRate: ordered[0].sampleRate } : {}),
            qualityTier: ordered.some((t) => t.qualityTier === "HI-RES LOSSLESS") ? "HI-RES LOSSLESS" : "LOSSLESS",
            tracks: ordered,
          };
        }
      }
      if (!album) throw new AppError("NOT_FOUND", "Album not found");

      const enrichedTracks = album.tracks.length
        ? await enrichTrackList(album.tracks, services.cache, services.streamFetch, services.demo ? 0 : 4)
        : [];
      const firstHi = enrichedTracks.find((t) => t.qualityTier === "HI-RES LOSSLESS") ?? enrichedTracks[0];
      const finalAlbum: AlbumDetailResponse = {
        ...album,
        tracks: enrichedTracks.sort((a, b) => (a.trackNumber ?? 9999) - (b.trackNumber ?? 9999)),
        trackCount: album.trackCount || enrichedTracks.length,
        totalDurationMs:
          album.totalDurationMs ||
          enrichedTracks.reduce((s, t) => s + (t.durationMs ?? (t.durationSec ?? 0) * 1000), 0),
        coverUrl: album.coverUrl ?? firstHi?.coverUrl,
        bitDepth: album.bitDepth ?? firstHi?.bitDepth,
        sampleRate: album.sampleRate ?? firstHi?.sampleRate,
        qualityTier: enrichedTracks.some((t) => t.qualityTier === "HI-RES LOSSLESS") ? "HI-RES LOSSLESS" : album.qualityTier,
      };
      await services.cache.set(cacheKey, finalAlbum, DETAIL_CACHE_TTL_MS);
      return finalAlbum;
    },
  );

  app.get<{ Params: { id: string } }>("/api/tracks/:id", { schema: { params: idParams } }, async (request) => {
    const track = await chain.getTrack(request.params.id);
    if (!track) throw new AppError("NOT_FOUND", "Track not found");
    return services.demo ? track : enrichTrackMetadata(track, services.cache, services.streamFetch);
  });

  // ------------------------------------------------------ prepare jobs ---
  const withSignedUrl = (request: FastifyRequest, status: PrepareStatus): PrepareStatus =>
    status.state === "ready"
      ? { ...status, signedStreamUrl: buildSignedStreamUrl(status.id, accessKey, Date.now(), 3600, requestOrigin(request)) }
      : status;

  const sendStatus = (request: FastifyRequest, reply: FastifyReply, status: PrepareStatus) => {
    const out = withSignedUrl(request, status);
    if (out.state === "error" && out.error) {
      return reply.code(statusFor(out.error.code)).send(out);
    }
    return reply.code(out.state === "preparing" ? 202 : 200).send(out);
  };

  app.post<{ Params: { id: string } }>("/api/tracks/:id/prepare", { schema: { params: idParams } }, async (request, reply) => {
    const id = request.params.id;
    const pending = tracker.ensure(id).then(
      () => undefined,
      () => undefined,
    );
    // Cache hits resolve within a few ms: answer "ready" right away instead of making the UI poll.
    await Promise.race([pending, sleep(300)]);
    return sendStatus(request, reply, tracker.status(id));
  });

  app.post<{ Body: ResolveTrackRequest }>(
    "/api/tracks/resolve",
    {
      schema: {
        body: {
          type: "object",
          required: ["title", "artist"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 200 },
            artist: { type: "string", minLength: 1, maxLength: 200 },
            album: { type: "string", maxLength: 200 },
          },
        },
      },
    },
    async (request): Promise<ResolveTrackResponse> => {
      const { title, artist } = request.body;
      const { tracks } = await chain.search(`${artist.trim()} ${title.trim()}`, { limit: 10 });
      const rawMatched = bestMatch({ title, artist }, tracks)?.candidate ?? tracks[0];
      if (!rawMatched) throw new AppError("NOT_FOUND", `No playable match for "${artist} - ${title}"`);
      const matched = services.demo
        ? rawMatched
        : await enrichTrackMetadata(rawMatched, services.cache, services.streamFetch).catch(() => rawMatched);
      const pending = tracker.ensure(matched.id).then(
        () => undefined,
        () => undefined,
      );
      await Promise.race([pending, sleep(1_500)]);
      const prepare = withSignedUrl(request, tracker.status(matched.id));
      const signedStreamUrl =
        prepare.signedStreamUrl ?? buildSignedStreamUrl(matched.id, accessKey, Date.now(), 3600, requestOrigin(request));
      const durationSec = matched.durationSec;
      const fileSize = matched.fileSize ?? prepare.fileSize;
      const bitrateKbps =
        matched.bitrateKbps ??
        prepare.bitrateKbps ??
        (fileSize && durationSec && durationSec > 0 ? Math.round((fileSize * 8) / durationSec / 1000) : undefined);
      const bitDepth = matched.bitDepth ?? prepare.bitDepth;
      const sampleRate = matched.sampleRate ?? prepare.sampleRate;
      const codec = matched.codec ?? prepare.codec ?? "FLAC";
      const isHiRes = (bitDepth !== undefined && bitDepth > 16) || (sampleRate !== undefined && sampleRate > 48_000);
      const enrichedTrack = {
        ...matched,
        codec,
        qualityTier: isHiRes ? ("HI-RES LOSSLESS" as const) : ("LOSSLESS" as const),
        ...(bitDepth ? { bitDepth } : {}),
        ...(sampleRate ? { sampleRate } : {}),
        ...(fileSize !== undefined ? { fileSize } : {}),
        ...(bitrateKbps !== undefined ? { bitrateKbps } : {}),
      };
      return { track: enrichedTrack, prepare, signedStreamUrl };
    },
  );

  app.get<{ Params: { id: string } }>("/api/tracks/:id/prepare", { schema: { params: idParams } }, async (request, reply) =>
    sendStatus(request, reply, tracker.status(request.params.id)),
  );

  // --------------------------------------------------- audio streaming ---
  const streamDeps = {
    chain,
    tracker,
    cache: services.cache,
    fetch: services.streamFetch,
    headerTimeoutMs: services.streamTimeoutMs,
    skipEnrich: Boolean(services.demo),
  };

  app.route<{ Params: { id: string }; Querystring: { artist?: string; title?: string } }>({
    method: ["GET", "HEAD"],
    url: "/api/stream/:id",
    exposeHeadRoute: false,
    schema: { params: idParams },
    handler: (request, reply) => proxyAudio(request, reply, streamDeps, "stream"),
  });

  app.get<{ Params: { id: string }; Querystring: { artist?: string; title?: string } }>(
    "/api/download/:id",
    { schema: { params: idParams, querystring: nameHints } },
    (request, reply) => proxyAudio(request, reply, streamDeps, "download"),
  );

  app.get<{ Params: { id: string } }>("/api/cover/:id", { schema: { params: idParams } }, async (request, reply) => {
    const { source } = await chain.coverSource(request.params.id);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), services.streamTimeoutMs);
    let res: Response;
    try {
      res = await services.streamFetch(source.url, { signal: controller.signal });
    } catch {
      throw new AppError("UPSTREAM_UNAVAILABLE", "Cover art host is unreachable");
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new AppError(res.status === 404 ? "NOT_FOUND" : "STREAM_UNAVAILABLE", "Cover art unavailable", { upstreamStatus: res.status });
    }
    reply
      .header("content-type", res.headers.get("content-type") ?? source.mimeType ?? "image/jpeg")
      .header("cache-control", "private, max-age=86400");
    const len = res.headers.get("content-length");
    if (len) reply.header("content-length", len);
    return reply.send(Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>));
  });

  // ------------------------------------------------- recommendations ---
  app.get<{ Querystring: RecommendationSeed & { seed?: SeedType; limit?: number } }>(
    "/api/recommendations",
    {
      schema: {
        querystring: {
          type: "object",
          properties: { ...seedProps, seed: seedProps.type, limit: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
        },
      },
    },
    async (request) => {
      const q = request.query;
      const type = (q.type ?? q.seed ?? (q.tag ? "tag" : q.title || q.trackId ? "track" : "artist")) as SeedType;
      const seed: RecommendationSeed = { type, ...strip({ trackId: q.trackId, artist: q.artist, title: q.title, tag: q.tag }) };
      return engine.recommend(seed, { limit: q.limit });
    },
  );

  app.get<{
    Querystring: {
      seedArtist?: string;
      seedTrack?: string;
      seedTitle?: string;
      nowPlayingArtist?: string;
      nowPlayingTrack?: string;
      genre?: string;
      limit?: number;
    };
  }>(
    "/api/home",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            seedArtist: { type: "string", maxLength: 200 },
            seedTrack: { type: "string", maxLength: 300 },
            seedTitle: { type: "string", maxLength: 200 },
            nowPlayingArtist: { type: "string", maxLength: 200 },
            nowPlayingTrack: { type: "string", maxLength: 300 },
            genre: { type: "string", maxLength: 100 },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
        },
      },
    },
    async (request): Promise<HomeResponse> => {
      const genre = request.query.genre?.trim() || "mixed";
      const nowArtist = request.query.nowPlayingArtist?.trim() || undefined;
      const nowTrack = request.query.nowPlayingTrack?.trim() || undefined;
      const seedArtist = request.query.seedArtist?.trim() || undefined;
      const seedTrack = request.query.seedTrack?.trim() || undefined;
      const seedTitle = request.query.seedTitle?.trim() || undefined;
      let seed: RecommendationSeed;
      if (seedTrack) {
        if (seedTrack.includes(":") && !seedTrack.includes(" ")) {
          seed = { type: "track", trackId: seedTrack, ...(seedArtist ? { artist: seedArtist } : {}), ...(seedTitle ? { title: seedTitle } : {}) };
        } else if (seedArtist) {
          seed = { type: "track", artist: seedArtist, title: seedTrack };
        } else if (seedTrack.includes(" - ")) {
          const [a, ...rest] = seedTrack.split(" - ");
          seed = { type: "track", artist: a!.trim(), title: rest.join(" - ").trim() };
        } else {
          seed = { type: "artist", artist: seedTrack };
        }
      } else if (seedArtist) {
        seed = { type: "artist", artist: seedArtist };
      } else if (nowTrack && nowArtist && (!request.query.genre || genre === "mixed")) {
        seed = { type: "track", artist: nowArtist, title: nowTrack };
      } else {
        seed = { type: "tag", tag: genre };
      }

      const [rec, becauseRec] = await Promise.all([
        engine.recommend(seed, { limit: request.query.limit }),
        nowTrack && nowArtist && seed.type === "tag"
          ? engine.recommend({ type: "track", artist: nowArtist, title: nowTrack }, { limit: 12 }).catch(() => null)
          : Promise.resolve(null),
      ]);

      const playableTracks = rec.relatedTracks.map((r) => r.track).filter((t): t is NonNullable<typeof t> => Boolean(t));
      const featuredTrack = playableTracks.find((t) => t.qualityTier === "HI-RES LOSSLESS") ?? playableTracks[0];
      const albums = deriveAlbumsFromTracks(playableTracks);

      return {
        genre,
        ...(seedArtist ? { seedArtist } : {}),
        ...(nowArtist && nowTrack ? { nowPlaying: { artist: nowArtist, track: nowTrack } } : {}),
        ...(becauseRec
          ? { becauseYouPlayed: { label: `Because you played ${nowTrack}`, tracks: becauseRec.relatedTracks } }
          : seed.type === "track" && nowTrack
            ? { becauseYouPlayed: { label: `Because you played ${nowTrack}`, tracks: rec.relatedTracks.slice(0, 12) } }
            : {}),
        ...(featuredTrack ? { featuredTrack } : {}),
        albums,
        ...rec,
      };
    },
  );

  // ------------------------------------------------------------- lyrics ---
  app.get<{ Querystring: { track?: string; title?: string; artist?: string; album?: string; duration?: string } }>(
    "/api/lyrics",
    {
      schema: {
        querystring: {
          type: "object",
          properties: {
            track: { type: "string", maxLength: 300 },
            title: { type: "string", maxLength: 300 },
            artist: { type: "string", maxLength: 300 },
            album: { type: "string", maxLength: 300 },
            duration: { type: "string", maxLength: 32 },
          },
        },
      },
    },
    async (request) => {
      const track = (request.query.track ?? request.query.title ?? "").trim();
      const artist = (request.query.artist ?? "").trim();
      const album = request.query.album?.trim() || undefined;
      const durNum = request.query.duration ? Number(request.query.duration) : undefined;
      return fetchLyrics({ track, artist, album, durationSec: durNum });
    },
  );

  app.post<{ Body: RadioRequest }>(
    "/api/radio",
    {
      schema: {
        body: {
          type: "object",
          required: ["seed"],
          properties: {
            seed: { type: "object", required: ["type"], properties: seedProps },
            exclude: { type: "array", maxItems: 1000, items: { type: "string", maxLength: 600 } },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 15 },
          },
        },
      },
    },
    async (request) => engine.radio(request.body.seed, { exclude: request.body.exclude, limit: request.body.limit }),
  );

  // --------------------------------------------------------- demo mode ---
  if (services.demo) {
    const demo = services.demo;
    app.get<{ Params: { file: string } }>("/__mock/cover/:file", async (request, reply) => {
      const id = request.params.file.replace(/\.svg$/, "");
      const track = demo.catalog.find((t) => t.id === id);
      if (!track) throw new AppError("NOT_FOUND", "No such demo cover");
      return reply.header("content-type", "image/svg+xml").header("cache-control", "public, max-age=86400").send(renderDemoCover(track));
    });
  }

  // ------------------------------------------------------ static client ---
  const distDir = config.clientDistDir
    ? resolve(config.clientDistDir)
    : resolve(dirname(fileURLToPath(import.meta.url)), "../../client/dist");
  if (existsSync(resolve(distDir, "index.html"))) {
    await app.register(fastifyStatic, {
      root: distDir,
      // Wildcard mode resolves files per request, so a client rebuild is picked up without a restart.
      wildcard: true,
      setHeaders(reply, path) {
        reply.header("cache-control", /[\\/]assets[\\/]/.test(path) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    app.setNotFoundHandler((request, reply) => {
      const path = request.url.split("?")[0] ?? "";
      // SPA fallback only for page-like paths; a missing /assets/x.js must stay a 404, not HTML.
      const looksLikeFile = /\.[a-z0-9]{1,8}$/i.test(path);
      if (request.method === "GET" && !looksLikeFile && !path.startsWith("/api/") && !path.startsWith("/__mock/")) {
        return reply.header("cache-control", "no-cache").sendFile("index.html");
      }
      return reply.code(404).send(new AppError("NOT_FOUND", `No route for ${request.method} ${path}`).toBody());
    });
  } else {
    app.setNotFoundHandler((request, reply) =>
      reply.code(404).send(new AppError("NOT_FOUND", `No route for ${request.method} ${request.url.split("?")[0]}`).toBody()),
    );
  }

  app.addHook("onClose", async () => {
    await services.close();
  });

  return app;
}

function requestOrigin(request: FastifyRequest): string | undefined {
  const proto = request.protocol || "https";
  const rawHost = request.headers["x-forwarded-host"] ?? request.headers.host;
  const host = (Array.isArray(rawHost) ? rawHost[0] : rawHost)?.split(",")[0]?.trim();
  return host ? `${proto}://${host}` : undefined;
}

function statusFor(code: ErrorCode): number {
  return new AppError(code, "").status;
}

function safeEqual(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

function strip<T extends Record<string, string | undefined>>(o: T): Partial<Record<keyof T, string>> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "string" && v.trim() !== "")) as Partial<Record<keyof T, string>>;
}
