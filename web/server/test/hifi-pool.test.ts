import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { MemoryCache } from "../src/lib/cache.js";
import { CachedProvider } from "../src/providers/cached.js";
import { ProviderChain } from "../src/providers/chain.js";
import { HiFiPoolProvider } from "../src/providers/hifi.js";
import { MockAudioProvider } from "../src/providers/mock.js";
import { RemoteMediaProvider } from "../src/providers/remote.js";
import { loadConfig } from "../src/config.js";

describe("HiFiPoolProvider", () => {
  it("round-robins instances, cools down on 429 retryAfterSeconds, and verifies 206 stream", async () => {
    let t = 1_000_000;
    const hits: string[] = [];
    const pool = new HiFiPoolProvider({
      instances: ["https://a.hifi.test", "https://b.hifi.test"],
      now: () => t,
      cooldownMs: 60_000,
      fetch: (async (url: string | URL) => {
        const u = String(url);
        hits.push(u);
        if (u.startsWith("https://a.hifi.test/search/tracks")) {
          return new Response(JSON.stringify({ retryAfterSeconds: 45 }), { status: 429 });
        }
        if (u.startsWith("https://b.hifi.test/search/tracks")) {
          return new Response(
            JSON.stringify({
              tracks: [{ trackId: "123", title: "One More Time", artistNames: ["Daft Punk"], duration: 320000 }],
            }),
            { status: 200 },
          );
        }
        if (u === "https://b.hifi.test/track/123") {
          return new Response("fLaC", { status: 206 });
        }
        return new Response("", { status: 404 });
      }) as typeof fetch,
    });

    const tracks = await pool.search("daft punk", { limit: 5 });
    expect(tracks).toHaveLength(1);
    expect(tracks[0]).toMatchObject({ id: "123", title: "One More Time", artist: "Daft Punk", durationSec: 320, lossless: true });

    // Next search skips cooled-down a.hifi.test and goes straight to b.hifi.test
    hits.length = 0;
    await pool.search("harnoor");
    expect(hits).toEqual(["https://b.hifi.test/search/tracks?q=harnoor&limit=25"]);

    const src = await pool.getStreamUrl("123");
    expect(src).toMatchObject({ url: "https://b.hifi.test/track/123", mimeType: "audio/flac", extension: "flac" });
    expect(await pool.getTrackMetadata("123")).toMatchObject({ id: "123", title: "One More Time", artist: "Daft Punk" });

    // After 45s cooldown expires, a.hifi.test is eligible again in round-robin
    t += 46_000;
    hits.length = 0;
    await pool.search("again1");
    await pool.search("again2");
    expect(hits.some((u) => u.startsWith("https://a.hifi.test"))).toBe(true);
  });
});

describe("ProviderChain multi-provider cooldown & RemoteMediaProvider rate limit", () => {
  it("cools down a 429 provider for retryAfterMs and reports open circuit in health()", async () => {
    let t = 5_000_000;
    const ttl = { searchMs: 1_800_000, streamUrlMs: 3_600_000, trackMs: 3_600_000 };
    const p1 = new CachedProvider(
      {
        name: "arcod",
        kind: "remote-media",
        async search() {
          throw new AppError("UPSTREAM_UNAVAILABLE", "rate limited", { upstreamStatus: 429, retryAfterMs: 60_000 });
        },
        async getTrackMetadata() {
          return null;
        },
        async getStreamUrl() {
          throw new Error("unused");
        },
      },
      new MemoryCache(),
      ttl,
      () => t,
    );
    const p2 = new CachedProvider(new MockAudioProvider({ name: "hifi" }), new MemoryCache(), ttl, () => t);
    const chain = new ProviderChain([p1, p2], { now: () => t });

    const res = await chain.search("test");
    expect(res.provider).toBe("hifi");
    expect(chain.health()).toEqual([
      { name: "arcod", kind: "remote-media", role: "primary", circuit: "open", lastError: "rate limited" },
      { name: "hifi", kind: "mock", role: "fallback", circuit: "closed" },
    ]);

    t += 61_000;
    expect(chain.health()[0]!.circuit).toBe("closed");
  });

  it("enforces soft searchMaxPerMin on RemoteMediaProvider", async () => {
    const cfg = loadConfig({ MEDIA_API_BASE: "https://m.test", MEDIA_SEARCH_MAX_PER_MIN: "2" }).remote!;
    const remote = new RemoteMediaProvider({
      config: cfg,
      auth: { getAccessToken: async () => undefined, invalidate() {} },
      now: () => 1_000_000,
      fetch: (async () => new Response(JSON.stringify({ tracks: [] }), { status: 200 })) as typeof fetch,
    });
    await remote.search("q1");
    await remote.search("q2");
    await expect(remote.search("q3")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", upstreamStatus: 429 });
  });

  it("rejects lossy audio/mpeg and audio/aac streams and fails over to the next lossless provider", async () => {
    const ttl = { searchMs: 1_800_000, streamUrlMs: 3_600_000, trackMs: 3_600_000 };
    const lossyHifi = new HiFiPoolProvider({
      name: "hifi",
      instances: ["https://lossy.hifi.test"],
      fetch: (async (url: string | URL) => {
        const u = String(url);
        if (u.includes("/search/tracks")) {
          return new Response(JSON.stringify({ tracks: [{ trackId: "1", title: "Karma Police", artistNames: ["Radiohead"] }] }), { status: 200 });
        }
        return new Response("ID3\u0003\u0000", { status: 206, headers: { "content-type": "audio/mpeg" } });
      }) as typeof fetch,
    });
    const backup = new MockAudioProvider({ name: "backup" });
    const cache = new MemoryCache();
    const p1 = new CachedProvider(lossyHifi, cache, ttl);
    const p2 = new CachedProvider(backup, cache, ttl);
    const chain = new ProviderChain([p1, p2]);

    await p1.searchWithMeta("Radiohead Karma Police");
    await expect(lossyHifi.getStreamUrl("1")).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });

    // Chain resolveStream fails over from lossy hifi to backup
    const resolved = await chain.resolveStream("hifi:1");
    expect(resolved.fallback).toBe(true);
    expect(resolved.servedBy.name).toBe("backup");

    const { verifyLosslessStream } = await import("../src/providers/types.js");
    expect(verifyLosslessStream("audio/aac").ok).toBe(false);
    expect(verifyLosslessStream("audio/mpeg").ok).toBe(false);
    expect(verifyLosslessStream("audio/flac", new Uint8Array([0x66, 0x4c, 0x61, 0x43])).ok).toBe(true);
  });
});
