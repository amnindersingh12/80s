import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from "fastify";
import fastifyStatic from "@fastify/static";
import type {
  DoctorResponse,
  ErrorCode,
  HealthResponse,
  PrepareStatus,
  RadioRequest,
  RecommendationSeed,
  SearchResponse,
  SeedType,
} from "../../shared/api.js";
import type { Config, Env } from "./config.js";
import { runDoctor } from "./doctor.js";
import type { DiscoveryResult } from "./lib/discovery.js";
import { AppError, isAppError, toAppError } from "./errors.js";
import { sleep } from "./lib/http.js";
import { renderDemoCover } from "./providers/mock.js";
import type { AppServices } from "./services.js";
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

export async function buildApp({ config, services, logger = false, env = process.env, doctorFetch, discovery }: BuildAppOptions): Promise<FastifyInstance> {
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
        "default-src 'self'; img-src 'self' https: data:; media-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
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
  app.get<{ Querystring: { q: string; limit: number } }>(
    "/api/search",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["q"],
          properties: {
            q: { type: "string", minLength: 1, maxLength: 200 },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 25 },
          },
        },
      },
    },
    async (request): Promise<SearchResponse> => {
      const q = request.query.q.trim();
      if (!q) throw new AppError("BAD_REQUEST", "Query must not be blank");
      const result = await chain.search(q, { limit: request.query.limit });
      return { query: q, ...result };
    },
  );

  app.get<{ Params: { id: string } }>("/api/tracks/:id", { schema: { params: idParams } }, async (request) => {
    const track = await chain.getTrack(request.params.id);
    if (!track) throw new AppError("NOT_FOUND", "Track not found");
    return track;
  });

  // ------------------------------------------------------ prepare jobs ---
  const sendStatus = (reply: FastifyReply, status: PrepareStatus) => {
    if (status.state === "error" && status.error) {
      return reply.code(statusFor(status.error.code)).send(status);
    }
    return reply.code(status.state === "preparing" ? 202 : 200).send(status);
  };

  app.post<{ Params: { id: string } }>("/api/tracks/:id/prepare", { schema: { params: idParams } }, async (request, reply) => {
    const id = request.params.id;
    const pending = tracker.ensure(id).then(
      () => undefined,
      () => undefined,
    );
    // Cache hits resolve within a few ms: answer "ready" right away instead of making the UI poll.
    await Promise.race([pending, sleep(300)]);
    return sendStatus(reply, tracker.status(id));
  });

  app.get<{ Params: { id: string } }>("/api/tracks/:id/prepare", { schema: { params: idParams } }, async (request, reply) =>
    sendStatus(reply, tracker.status(request.params.id)),
  );

  // --------------------------------------------------- audio streaming ---
  const streamDeps = { chain, tracker, fetch: services.streamFetch, headerTimeoutMs: services.streamTimeoutMs };

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
