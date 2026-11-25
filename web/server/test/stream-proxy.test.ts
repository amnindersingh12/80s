import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { AppError } from "../src/errors.js";
import { MemoryCache } from "../src/lib/cache.js";
import { MockAudioProvider } from "../src/providers/mock.js";
import { createServices } from "../src/services.js";
import { demoConfig } from "./helpers/config.js";
import { fakeAudio, startFakeUpstream, type FakeUpstream } from "./helpers/fakeUpstream.js";

const SIZE = 100_000;
let up: FakeUpstream;
let app: FastifyInstance;
let mock: MockAudioProvider;
let audio: Buffer;

const TRACKS = [
  { id: "t1", title: "Lover", artist: "Diljit Dosanjh", lossless: true, format: "flac" },
  { id: "pa", title: "ਪਿਆਰ / Pyaar", artist: "Gurdas Maan", lossless: true, format: "flac" },
];

async function setup(opts: { signature?: () => string; cdnType?: string } = {}) {
  up = await startFakeUpstream();
  audio = fakeAudio(SIZE);
  up.state.cdnFiles.set("t1.flac", { body: audio, type: opts.cdnType ?? "audio/flac" });
  up.state.cdnFiles.set("pa.flac", { body: audio, type: "application/octet-stream" });
  mock = new MockAudioProvider({
    name: "remote",
    tracks: TRACKS,
    streamUrl: (id) => `${up.url}/cdn/${id}.flac?sig=${opts.signature?.() ?? "good"}`,
  });
  const config = demoConfig({ DEMO_MODE: "false" });
  const services = await createServices(config, { primary: mock, cache: new MemoryCache() });
  app = await buildApp({ config, services });
  await app.ready();
}

beforeEach(async () => setup());
afterEach(async () => {
  await app.close();
  await up.close();
});

describe("GET /api/stream/:id — Range pass-through", () => {
  it("forwards a byte range and returns 206 with Content-Range / Accept-Ranges", async () => {
    const res = await app.inject({ url: "/api/stream/remote:t1", headers: { range: "bytes=100-199" } });
    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 100-199/${SIZE}`);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-length"]).toBe("100");
    expect(res.headers["content-type"]).toBe("audio/flac");
    expect(res.rawPayload.equals(audio.subarray(100, 200))).toBe(true);
    expect(up.state.cdnRequests[0]).toMatchObject({ range: "bytes=100-199", method: "GET" });
  });

  it("supports open-ended and suffix ranges (what <audio> sends when seeking)", async () => {
    const open = await app.inject({ url: "/api/stream/remote:t1", headers: { range: `bytes=${SIZE - 10}-` } });
    expect(open.statusCode).toBe(206);
    expect(open.headers["content-range"]).toBe(`bytes ${SIZE - 10}-${SIZE - 1}/${SIZE}`);
    expect(open.rawPayload.equals(audio.subarray(SIZE - 10))).toBe(true);

    const suffix = await app.inject({ url: "/api/stream/remote:t1", headers: { range: "bytes=-50" } });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.rawPayload.equals(audio.subarray(SIZE - 50))).toBe(true);
  });

  it("returns the full body with 200 and Accept-Ranges when no Range is sent", async () => {
    const res = await app.inject({ url: "/api/stream/remote:t1" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-length"]).toBe(String(SIZE));
    expect(res.headers.etag).toBe(`"t1.flac-${SIZE}"`);
    expect(res.rawPayload.equals(audio)).toBe(true);
  });

  it("passes 416 through for unsatisfiable ranges", async () => {
    const res = await app.inject({ url: "/api/stream/remote:t1", headers: { range: `bytes=${SIZE + 5}-` } });
    expect(res.statusCode).toBe(416);
    expect(res.headers["content-range"]).toBe(`bytes */${SIZE}`);
  });

  it("answers HEAD with the full length using a 1-byte ranged GET upstream", async () => {
    const res = await app.inject({ method: "HEAD", url: "/api/stream/remote:t1" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-length"]).toBe(String(SIZE));
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-range"]).toBeUndefined();
    expect(res.rawPayload.length).toBe(0);
    expect(up.state.cdnRequests[0]).toMatchObject({ method: "GET", range: "bytes=0-0" });
  });

  it("rewrites application/octet-stream to an audio type the browser can play", async () => {
    const res = await app.inject({ url: "/api/stream/remote:pa", headers: { range: "bytes=0-3" } });
    expect(res.headers["content-type"]).toBe("audio/flac");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("re-resolves once when the cached signed URL has expired (CDN 403)", async () => {
    await app.close();
    await up.close();
    let n = 0;
    await setup({ signature: () => (++n === 1 ? "expired" : "good") });
    const res = await app.inject({ url: "/api/stream/remote:t1", headers: { range: "bytes=0-9" } });
    expect(res.statusCode).toBe(206);
    expect(mock.calls.getStreamUrl).toBe(2);
    expect(up.state.cdnRequests.map((r) => r.path)).toEqual(["/cdn/t1.flac", "/cdn/t1.flac"]);
  });

  it("returns 502 JSON (no signed URL leak) when the CDN keeps refusing", async () => {
    await app.close();
    await up.close();
    await setup({ signature: () => "expired" });
    const res = await app.inject({ url: "/api/stream/remote:t1" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ error: { code: "STREAM_UNAVAILABLE", upstreamStatus: 403 } });
    expect(res.body).not.toContain("sig=");
    expect(res.body).not.toContain(up.url);
  });

  it("maps provider job timeouts to a clean 504 JSON error", async () => {
    mock.fail("getStreamUrl", new AppError("JOB_TIMEOUT", "still preparing after 45 s"));
    const res = await app.inject({ url: "/api/stream/remote:t1" });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({ error: { code: "JOB_TIMEOUT", message: "still preparing after 45 s", retryable: true } });
  });

  it("maps an unreachable media server to 503", async () => {
    mock.fail("getStreamUrl", new AppError("UPSTREAM_UNAVAILABLE", "down", { upstreamStatus: 502 }));
    const res = await app.inject({ url: "/api/stream/remote:t1" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("aborts the upstream transfer when the browser disconnects", async () => {
    up.state.cdnSlowStreamMs = 15;
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    expect(address).toContain(String(port));
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: "/api/stream/remote:t1" }, (res) => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => undefined);
      req.end();
      setTimeout(() => reject(new Error("no data")), 3_000);
    });
    await expect.poll(() => up.state.cdnClosedEarly, { timeout: 2_000 }).toBe(1);
  });
});

describe("GET /api/download/:id", () => {
  it("sets Content-Disposition: attachment; filename=\"Artist - Title.flac\"", async () => {
    await app.inject({ url: "/api/search?q=lover" }); // warms metadata cache like the UI does
    const res = await app.inject({ url: "/api/download/remote:t1" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="Diljit Dosanjh - Lover.flac"; filename*=UTF-8''Diljit%20Dosanjh%20-%20Lover.flac`,
    );
    expect(res.rawPayload.equals(audio)).toBe(true);
  });

  it("sanitises unsafe characters and keeps Unicode via RFC 5987 filename*", async () => {
    const res = await app.inject({ url: "/api/download/remote:pa" });
    const cd = res.headers["content-disposition"] as string;
    expect(cd).toMatch(/^attachment; filename="Gurdas Maan - _+ Pyaar\.flac"; filename\*=UTF-8''/);
    expect(decodeURIComponent(cd.split("''")[1]!)).toBe("Gurdas Maan - ਪਿਆਰ Pyaar.flac");
    expect(cd).not.toContain("/");
  });

  it("uses artist/title hints when the provider has no metadata", async () => {
    mock.fail("getTrackMetadata", new AppError("UPSTREAM_TIMEOUT", "slow"));
    const res = await app.inject({ url: "/api/download/remote:t1?artist=AP%20Dhillon&title=With%20You" });
    expect(res.headers["content-disposition"]).toContain('filename="AP Dhillon - With You.flac"');
  });
});
