import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { SESSION_COOKIE, buildApp } from "../src/app.js";
import type { Env } from "../src/config.js";
import { AppError } from "../src/errors.js";
import { MemoryCache } from "../src/lib/cache.js";
import { MockAudioProvider } from "../src/providers/mock.js";
import { createServices } from "../src/services.js";
import { demoConfig } from "./helpers/config.js";

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function make(env: Env = {}, primary?: MockAudioProvider) {
  const config = demoConfig(env);
  const services = await createServices(config, { cache: new MemoryCache(), ...(primary ? { primary } : {}) });
  app = await buildApp({ config, services });
  await app.ready();
  return app;
}

describe("API routes", () => {
  it("reports health without leaking configuration", async () => {
    const a = await make();
    const res = await a.inject("/api/health");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      demo: true,
      providers: [{ name: "demo", kind: "mock", role: "primary", circuit: "closed" }],
      recommendations: { lastfm: false, listenbrainz: false, musicbrainz: false },
      cache: "memory",
      mediaAuth: null,
      configErrors: [],
      discovery: "off",
      accessRequired: false,
      authenticated: true,
    });
  });

  it("searches with public ids and validates the query", async () => {
    const a = await make();
    const res = await a.inject("/api/search?q=moose");
    expect(res.json()).toMatchObject({ query: "moose", provider: "demo", fallback: false, cached: false });
    expect(res.json().tracks[0]).toMatchObject({ id: "demo:demo-08", title: "295", artist: "Sidhu Moose Wala", lossless: true });
    expect((await a.inject("/api/search?q=moose")).json().cached).toBe(true);

    expect((await a.inject("/api/search")).statusCode).toBe(400);
    expect((await a.inject("/api/search?q=%20%20")).json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect((await a.inject("/api/search?q=x&limit=500")).statusCode).toBe(400);
  });

  it("returns track metadata and 404 for unknown tracks", async () => {
    const a = await make();
    expect((await a.inject("/api/tracks/demo:demo-01")).json()).toMatchObject({ title: "Lover" });
    expect((await a.inject("/api/tracks/demo:nope")).statusCode).toBe(404);
  });

  it("reports job progress through prepare → poll → ready", async () => {
    const slow = new MockAudioProvider({ name: "demo" }).delay("getStreamUrl", 500);
    const a = await make({}, slow);
    const started = await a.inject({ method: "POST", url: "/api/tracks/demo:demo-03/prepare" });
    expect(started.statusCode).toBe(202);
    expect(started.json()).toMatchObject({ id: "demo:demo-03", state: "preparing", stage: "queued" });

    const polled = await a.inject("/api/tracks/demo:demo-03/prepare");
    expect(polled.json().state).toBe("preparing");
    expect(polled.json().elapsedMs).toBeGreaterThanOrEqual(0);

    await expect
      .poll(async () => (await a.inject("/api/tracks/demo:demo-03/prepare")).json().state, { timeout: 3_000, interval: 50 })
      .toBe("ready");
    const ready = (await a.inject("/api/tracks/demo:demo-03/prepare")).json();
    expect(ready).toMatchObject({ state: "ready", servedBy: "demo", fallback: false });

    // cached now → POST answers "ready" immediately
    const again = await a.inject({ method: "POST", url: "/api/tracks/demo:demo-03/prepare" });
    expect(again.statusCode).toBe(200);
    expect(again.json().state).toBe("ready");
    expect(slow.calls.getStreamUrl).toBe(1);
  });

  it("surfaces job failures with their HTTP status and lets the client retry", async () => {
    const flaky = new MockAudioProvider({ name: "demo" }).fail("getStreamUrl", new AppError("JOB_TIMEOUT", "still packaging"));
    const a = await make({}, flaky);
    const res = await a.inject({ method: "POST", url: "/api/tracks/demo:demo-01/prepare" });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toMatchObject({ state: "error", error: { code: "JOB_TIMEOUT", retryable: true } });

    flaky.fail("getStreamUrl");
    const retry = await a.inject({ method: "POST", url: "/api/tracks/demo:demo-01/prepare" });
    expect(retry.json().state).toBe("ready");
  });

  it("returns JSON 404s for unknown API routes and sets security headers", async () => {
    const a = await make();
    const res = await a.inject("/api/nope");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("serves demo covers as SVG", async () => {
    const a = await make();
    const res = await a.inject("/__mock/cover/demo-01.svg");
    expect(res.headers["content-type"]).toBe("image/svg+xml");
    expect(res.body).toContain("<svg");
  });

  it("streams synthetic demo audio through the same proxy path", async () => {
    const a = await make();
    const res = await a.inject({ url: "/api/stream/demo:demo-01", headers: { range: "bytes=0-43" } });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.subarray(0, 4).toString()).toBe("RIFF");
    expect(res.headers["content-type"]).toBe("audio/wav");
  });
});

describe("APP_ACCESS_KEY gate", () => {
  const KEY = "correct horse battery staple";

  it("blocks API calls until the access key is presented, then issues an HttpOnly cookie", async () => {
    const a = await make({ APP_ACCESS_KEY: KEY });
    const blocked = await a.inject("/api/search?q=x");
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().error.code).toBe("ACCESS_REQUIRED");
    expect((await a.inject("/api/stream/demo:demo-01")).statusCode).toBe(401);

    const health = (await a.inject("/api/health")).json();
    expect(health).toMatchObject({ accessRequired: true, authenticated: false });

    const wrong = await a.inject({ method: "POST", url: "/api/session", payload: { key: "nope" } });
    expect(wrong.statusCode).toBe(401);

    const ok = await a.inject({ method: "POST", url: "/api/session", payload: { key: KEY } });
    expect(ok.statusCode).toBe(200);
    const cookie = String(ok.headers["set-cookie"]);
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[^;]+; Path=/; HttpOnly; SameSite=Strict`));
    expect(cookie).not.toContain(KEY);

    const value = cookie.split(";")[0]!;
    expect((await a.inject({ url: "/api/search?q=karma", headers: { cookie: value } })).statusCode).toBe(200);
    expect((await a.inject({ url: "/api/health", headers: { cookie: value } })).json().authenticated).toBe(true);
    expect((await a.inject({ url: "/api/search?q=karma", headers: { authorization: `Bearer ${KEY}` } })).statusCode).toBe(200);
    expect((await a.inject({ url: "/api/search?q=karma", headers: { cookie: `${SESSION_COOKIE}=forged` } })).statusCode).toBe(401);
  });

  it("rejects too-short access keys at startup", () => {
    expect(() => demoConfig({ APP_ACCESS_KEY: "short" })).toThrow(/APP_ACCESS_KEY/);
  });
});

describe("static client serving", () => {
  it("serves files added after startup, falls back to index.html for app routes, and 404s missing assets", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "80s-dist-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>80s</title>");
    const a = await make({ CLIENT_DIST_DIR: dir });

    writeFileSync(join(dir, "assets", "late-abc123.js"), "console.log(1)"); // simulates a rebuild
    const js = await a.inject("/assets/late-abc123.js");
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/javascript/);
    expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable");

    const page = await a.inject("/discover/deep/link");
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    expect(page.headers["content-security-policy"]).toContain("default-src 'self'");

    expect((await a.inject("/assets/missing.js")).statusCode).toBe(404);
    expect((await a.inject("/api/missing")).json().error.code).toBe("NOT_FOUND");
  });

  it("resolves metadata-only tracks via POST /api/tracks/resolve and serves GET /api/home", async () => {
    const a = await make();
    const resolved = await a.inject({
      method: "POST",
      url: "/api/tracks/resolve",
      payload: { title: "Karma Police", artist: "Radiohead" },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().track.title).toContain("Karma Police");
    expect(resolved.json().prepare.state).toBe("ready");

    const home = await a.inject("/api/home");
    expect(home.statusCode).toBe(200);
    expect(home.json().genre).toBe("mixed");
    expect(home.json().seed.tag).toBe("mixed");

    const popHome = await a.inject("/api/home?genre=pop");
    expect(popHome.statusCode).toBe(200);
    expect(popHome.json().genre).toBe("pop");
    expect(popHome.json().seed.tag).toBe("pop");

    const seedTrackHome = await a.inject("/api/home?seedArtist=Radiohead&seedTrack=Karma+Police");
    expect(seedTrackHome.statusCode).toBe(200);
    expect(seedTrackHome.json().seed).toMatchObject({ type: "track", artist: "Radiohead", title: "Karma Police" });
    expect(resolved.json().signedStreamUrl).toMatch(/^\/api\/stream\/demo%3Ademo-12/);
  });

  it("allows GET/HEAD /api/stream/:id via signed ?st= token while keeping other endpoints gated", async () => {
    const a = await make({ APP_ACCESS_KEY: "correct horse battery staple" });
    const session = await a.inject({ method: "POST", url: "/api/session", payload: { key: "correct horse battery staple" } });
    const cookie = String(session.headers["set-cookie"]).split(";")[0]!;

    const prep = await a.inject({ method: "POST", url: "/api/tracks/demo:demo-01/prepare", headers: { cookie } });
    expect(prep.statusCode).toBe(200);
    const signedUrl = prep.json().signedStreamUrl as string;
    expect(signedUrl).toContain("?st=");

    const headRes = await a.inject({ method: "HEAD", url: signedUrl });
    expect(headRes.statusCode).toBe(200);

    const streamRes = await a.inject({ url: signedUrl, headers: { range: "bytes=0-43" } });
    expect(streamRes.statusCode).toBe(206);
    expect(streamRes.rawPayload.subarray(0, 4).toString()).toBe("RIFF");

    // Token is bound to track id and strictly scoped to /api/stream/:id
    const token = signedUrl.split("?st=")[1]!;
    expect((await a.inject(`/api/stream/demo:demo-02?st=${token}`)).statusCode).toBe(401);
    expect((await a.inject(`/api/search?q=karma&st=${token}`)).statusCode).toBe(401);
    expect((await a.inject(`/api/download/demo:demo-01?st=${token}`)).statusCode).toBe(401);
    expect((await a.inject(`/api/stream/demo:demo-01?st=1.bad`)).statusCode).toBe(401);
  });
});
