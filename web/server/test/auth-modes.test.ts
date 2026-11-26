import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { ConfigError, loadConfig, type Env } from "../src/config.js";
import { MemoryCache } from "../src/lib/cache.js";
import { createServices } from "../src/services.js";
import { fakeAudio, startFakeUpstream, type FakeUpstream } from "./helpers/fakeUpstream.js";

const FAST: Env = {
  MEDIA_REQUEST_TIMEOUT_MS: "500",
  MEDIA_JOB_POLL_INTERVAL_MS: "20",
  MEDIA_JOB_MAX_WAIT_MS: "1000",
  LISTENBRAINZ_ENABLED: "false",
  MUSICBRAINZ_ENABLED: "false",
};

describe("MEDIA_AUTH_MODE config", () => {
  it("defaults to none (live, not demo) when only MEDIA_API_BASE is set", () => {
    const c = loadConfig({ MEDIA_API_BASE: "https://media.example.com" });
    expect(c.demo).toBe(false);
    expect(c.remote?.authMode).toBe("none");
    expect(c.cacheTtl.streamUrlMs).toBe(1_200_000);
  });

  it("auto picks supabase when login credentials are set, keeping the 6 h stream-url TTL", () => {
    const c = loadConfig({
      MEDIA_API_BASE: "https://media.example.com",
      SUPABASE_URL: "https://p.supabase.co",
      SUPABASE_ANON_KEY: "anon",
      MEDIA_REFRESH_TOKEN: "rt",
    });
    expect(c.remote).toMatchObject({ authMode: "supabase", authModeSetting: "auto" });
    expect(c.cacheTtl.streamUrlMs).toBe(21_600_000);
  });

  it("validates each mode's requirements", () => {
    expect(() => loadConfig({ MEDIA_API_BASE: "https://m.test", MEDIA_AUTH_MODE: "bearer" })).toThrow(/MEDIA_BEARER_TOKEN is required/);
    expect(() => loadConfig({ MEDIA_API_BASE: "https://m.test", MEDIA_AUTH_MODE: "supabase" })).toThrow(ConfigError);
    expect(() => loadConfig({ MEDIA_API_BASE: "https://m.test", MEDIA_AUTH_MODE: "oauth" })).toThrow(/MEDIA_AUTH_MODE/);
    const b = loadConfig({ MEDIA_API_BASE: "https://m.test", MEDIA_AUTH_MODE: "bearer", MEDIA_BEARER_TOKEN: "tok" });
    expect(b.remote).toMatchObject({ authMode: "bearer", bearerToken: "tok" });
    expect(loadConfig({ MEDIA_API_BASE: "https://m.test", STREAM_URL_CACHE_TTL_MS: "60000" }).cacheTtl.streamUrlMs).toBe(60_000);
  });

  it("listens on 0.0.0.0 on Heroku and caps the in-memory cache", () => {
    expect(loadConfig({ DYNO: "web.1" }).host).toBe("0.0.0.0");
    expect(loadConfig({}).host).toBe("127.0.0.1");
    expect(loadConfig({}).memoryCacheMaxEntries).toBe(1_000);
  });
});

describe("live flow without Supabase", () => {
  let up: FakeUpstream;
  let app: FastifyInstance;
  const audio = fakeAudio(32_000);

  async function boot(env: Env) {
    const config = loadConfig({ MEDIA_API_BASE: up.url, ...FAST, ...env });
    const services = await createServices(config, { cache: new MemoryCache() });
    app = await buildApp({ config, services });
    await app.ready();
  }

  async function playThrough() {
    const search = await app.inject("/api/search?q=lover");
    expect(search.statusCode).toBe(200);
    expect(search.json().tracks[0]).toMatchObject({ id: "remote:t1", title: "Lover" });
    await app.inject({ method: "POST", url: "/api/tracks/remote:t1/prepare" });
    await expect.poll(async () => (await app.inject("/api/tracks/remote:t1/prepare")).json().state, { timeout: 3000, interval: 25 }).toBe("ready");
    const range = await app.inject({ url: "/api/stream/remote:t1", headers: { range: "bytes=0-99" } });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload.equals(audio.subarray(0, 100))).toBe(true);
  }

  beforeEach(async () => {
    up = await startFakeUpstream({ pollsUntilDone: 1 });
    up.state.cdnFiles.set("t1.flac", { body: audio, type: "audio/flac" });
  });
  afterEach(async () => {
    await app?.close();
    await up.close();
  });

  it("none: search, prepare, job polls and stream go out without any auth header", async () => {
    up.state.requireAuth = false;
    await boot({});
    const health = (await app.inject("/api/health")).json();
    expect(health).toMatchObject({ demo: false, mediaAuth: "none" });

    await playThrough();
    const paths = up.state.mediaAuthHeaders.map((h) => h.path);
    expect(paths).toContain("/api/search");
    expect(paths).toContain("/api/download"); // job create
    expect(paths.some((p) => p.startsWith("/api/jobs/"))).toBe(true); // job poll
    expect(up.state.mediaAuthHeaders.every((h) => h.auth === undefined)).toBe(true);
    expect(up.state.cdnRequests.every((r) => r.auth === undefined)).toBe(true);
    expect(up.state.authCalls).toEqual([]);
  });

  it("none: a 401 from the media server is reported with a hint, not retried", async () => {
    await boot({}); // fake upstream still requires a token
    const res = await app.inject("/api/search?q=lover");
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ code: "UPSTREAM_AUTH_FAILED" });
    expect(res.json().error.message).toContain("MEDIA_AUTH_MODE=bearer");
    expect(up.state.mediaAuthHeaders).toHaveLength(1);
  });

  it("bearer: every media request carries the static token, Supabase is never called", async () => {
    up.state.validTokens.add("static-token");
    await boot({ MEDIA_AUTH_MODE: "bearer", MEDIA_BEARER_TOKEN: "static-token" });
    expect((await app.inject("/api/health")).json().mediaAuth).toBe("bearer");
    await playThrough();
    expect(up.state.mediaAuthHeaders.length).toBeGreaterThanOrEqual(3);
    expect(up.state.mediaAuthHeaders.every((h) => h.auth === "Bearer static-token")).toBe(true);
    expect(up.state.authCalls).toEqual([]);
  });
});

describe("GET /api/doctor", () => {
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  async function boot(env: Env) {
    const config = loadConfig({ DEMO_MODE: "true", ...FAST, ...env });
    const services = await createServices(config, { cache: new MemoryCache() });
    const doctorFetch = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    app = await buildApp({ config, services, env: { ...FAST, ...env }, doctorFetch });
    await app.ready();
  }

  it("is disabled without APP_ACCESS_KEY", async () => {
    await boot({});
    const res = await app.inject("/api/doctor");
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toContain("APP_ACCESS_KEY");
  });

  it("requires the access key and returns the doctor report", async () => {
    await boot({ APP_ACCESS_KEY: "doctor-key-12345", MEDIA_USER_PASSWORD: "hunter2-secret" });
    expect((await app.inject("/api/doctor")).statusCode).toBe(401);
    const res = await app.inject({ url: "/api/doctor", headers: { authorization: "Bearer doctor-key-12345" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.steps.map((s: { name: string }) => s.name)).toEqual(["discovery", "env", "auth", "search", "recommendations"]);
    expect(body.lines.join("\n")).toContain("Environment");
    expect(JSON.stringify(body)).not.toContain("doctor-key-12345");
    expect(JSON.stringify(body)).not.toContain("hunter2-secret");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});
