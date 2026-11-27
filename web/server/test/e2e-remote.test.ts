import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { MemoryCache } from "../src/lib/cache.js";
import { MockAudioProvider } from "../src/providers/mock.js";
import { createServices } from "../src/services.js";
import { remoteEnv } from "./helpers/config.js";
import { fakeAudio, startFakeUpstream, type FakeUpstream } from "./helpers/fakeUpstream.js";

/**
 * Full stack over HTTP with the real RemoteMediaProvider + SupabaseAuth against
 * a fake Supabase / media server / R2 CDN — no mocks in the request path.
 */
let up: FakeUpstream;
let app: FastifyInstance;
const audio = fakeAudio(64_000);

async function boot(extra: Record<string, string> = {}, fallback?: MockAudioProvider) {
  const config = loadConfig(remoteEnv(up.url, { MEDIA_JOB_POLL_INTERVAL_MS: "30", ...extra }));
  const services = await createServices(config, { cache: new MemoryCache(), ...(fallback ? { fallback } : {}) });
  app = await buildApp({ config, services });
  await app.ready();
}

beforeEach(async () => {
  up = await startFakeUpstream({ pollsUntilDone: 3 });
  up.state.cdnFiles.set("t1.flac", { body: audio, type: "application/octet-stream" });
});
afterEach(async () => {
  await app?.close();
  await up.close();
});

describe("end to end: remote media server", () => {
  it("search → prepare (job polling) → ranged stream → download", async () => {
    // Serve the "R2" URL from a different origin than MEDIA_API_BASE (localhost vs 127.0.0.1).
    const cdnOrigin = up.url.replace("127.0.0.1", "localhost");
    up.state.signedUrlFor = (id) => `${cdnOrigin}/cdn/${id}.flac?X-Amz-Date=20991231T000000Z&X-Amz-Expires=3600&sig=good`;
    await boot({ MEDIA_JOB_POLL_INTERVAL_MS: "150" }); // 3 polls ≈ 450 ms > the 300 ms fast-path window
    const search = (await app.inject("/api/search?q=lover")).json();
    expect(search).toMatchObject({ provider: "remote", fallback: false });
    expect(search.tracks[0]).toMatchObject({ id: "remote:t1", title: "Lover", lossless: true, bitDepth: 24, sampleRate: 96000 });

    const started = await app.inject({ method: "POST", url: "/api/tracks/remote:t1/prepare" });
    expect(started.statusCode).toBe(202);
    await expect.poll(async () => (await app.inject("/api/tracks/remote:t1/prepare")).json().state, { timeout: 3000, interval: 25 }).toBe("ready");

    const range = await app.inject({ url: "/api/stream/remote:t1", headers: { range: "bytes=1000-1999" } });
    expect(range.statusCode).toBe(206);
    expect(range.headers["content-range"]).toBe(`bytes 1000-1999/${audio.length}`);
    expect(range.headers["content-type"]).toBe("audio/flac");
    expect(range.rawPayload.equals(audio.subarray(1000, 2000))).toBe(true);

    const dl = await app.inject("/api/download/remote:t1");
    expect(dl.headers["content-disposition"]).toContain('filename="Diljit Dosanjh - Lover.flac"');

    // One sign-in, one job, signed URL reused from cache for every byte range.
    expect(up.state.authCalls.map((c) => c.grant)).toEqual(["password"]);
    expect(up.state.jobCreateBodies).toEqual([{ trackId: "t1" }]);
    expect(up.state.cdnRequests.length).toBeGreaterThan(0);
    expect(up.state.cdnRequests.every((r) => r.auth === undefined)).toBe(true); // the media JWT never reaches the CDN
  });

  it("returns a 504 JSON error when the packaging job stalls past the cap", async () => {
    up.state.pollsUntilDone = Number.POSITIVE_INFINITY;
    await boot({ MEDIA_JOB_MAX_WAIT_MS: "200" });
    const res = await app.inject("/api/stream/remote:t1");
    expect(res.statusCode).toBe(504);
    expect(res.json().error).toMatchObject({ code: "JOB_TIMEOUT", retryable: true });
  });

  it("fails over to the fallback provider when the media server stalls", async () => {
    up.state.searchDelayMs = 2_000;
    const fallback = new MockAudioProvider({
      name: "subsonic",
      tracks: [{ id: "nd-1", title: "Lover", artist: "Diljit Dosanjh", lossless: true, format: "flac" }],
      streamUrl: () => `${up.url}/cdn/t1.flac?sig=good`,
    });
    await boot({ MEDIA_REQUEST_TIMEOUT_MS: "100" }, fallback);
    const search = (await app.inject("/api/search?q=lover")).json();
    expect(search).toMatchObject({ provider: "subsonic", fallback: true });
    const health = (await app.inject("/api/health")).json();
    expect(health.providers[0]).toMatchObject({ role: "primary", circuit: "open" });
    const stream = await app.inject({ url: `/api/stream/${search.tracks[0].id}`, headers: { range: "bytes=0-9" } });
    expect(stream.statusCode).toBe(206);
    expect(stream.headers["x-served-by"]).toBe("subsonic");
  });
});
