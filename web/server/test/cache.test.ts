import { describe, expect, it, vi } from "vitest";
import { MemoryCache, RedisCache, createCache, type RedisLike } from "../src/lib/cache.js";
import { CachedProvider, URL_EXPIRY_SAFETY_MS } from "../src/providers/cached.js";
import { MockAudioProvider } from "../src/providers/mock.js";

describe("MemoryCache", () => {
  it("expires entries after their TTL", async () => {
    const clock = { t: 0 };
    const c = new MemoryCache(100, () => clock.t);
    await c.set("k", { v: 1 }, 1_000);
    clock.t = 999;
    expect(await c.get("k")).toEqual({ v: 1 });
    clock.t = 1_000;
    expect(await c.get("k")).toBeUndefined();
  });

  it("evicts least-recently-used entries beyond maxEntries", async () => {
    const c = new MemoryCache(2);
    await c.set("a", 1, 60_000);
    await c.set("b", 2, 60_000);
    await c.get("a"); // a becomes most recent
    await c.set("c", 3, 60_000);
    expect(await c.get("b")).toBeUndefined();
    expect(await c.get("a")).toBe(1);
    expect(c.size).toBe(2);
  });

  it("isolates stored values from later mutation", async () => {
    const c = new MemoryCache();
    const value = { list: [1] };
    await c.set("k", value, 60_000);
    value.list.push(2);
    const got = await c.get<{ list: number[] }>("k");
    got!.list.push(3);
    expect(await c.get("k")).toEqual({ list: [1] });
  });

  it("ignores non-positive TTLs", async () => {
    const c = new MemoryCache();
    await c.set("k", 1, 0);
    expect(await c.get("k")).toBeUndefined();
  });
});

describe("RedisCache", () => {
  function fakeRedis(): RedisLike & { store: Map<string, { v: string; px: number }> } {
    const store = new Map<string, { v: string; px: number }>();
    return {
      store,
      get: async (k) => store.get(k)?.v ?? null,
      set: async (k, v, _mode, px) => { store.set(k, { v, px }); return "OK"; },
      del: async (k) => { store.delete(k); return 1; },
      quit: async () => "OK",
    };
  }

  it("prefixes keys, serialises JSON and sets PX TTLs", async () => {
    const r = fakeRedis();
    const c = new RedisCache(r, "80s:");
    await c.set("search:x", [{ id: 1 }], 900_000);
    expect(r.store.get("80s:search:x")).toEqual({ v: '[{"id":1}]', px: 900_000 });
    expect(await c.get("search:x")).toEqual([{ id: 1 }]);
    await c.delete("search:x");
    expect(await c.get("search:x")).toBeUndefined();
  });

  it("treats Redis outages as cache misses instead of failing requests", async () => {
    const onError = vi.fn();
    const broken: RedisLike = {
      get: async () => { throw new Error("ECONNREFUSED"); },
      set: async () => { throw new Error("ECONNREFUSED"); },
      del: async () => { throw new Error("ECONNREFUSED"); },
      quit: async () => "OK",
    };
    const c = new RedisCache(broken, "p:", onError);
    expect(await c.get("k")).toBeUndefined();
    await expect(c.set("k", 1, 1000)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it("falls back to the memory store when REDIS_URL is unset", async () => {
    expect((await createCache({})).kind).toBe("memory");
  });

  it.skipIf(!process.env.TEST_REDIS_URL)("round-trips through a real Redis (TEST_REDIS_URL)", async () => {
    const c = await createCache({ redisUrl: process.env.TEST_REDIS_URL, prefix: `test:${Date.now()}:` });
    expect(c.kind).toBe("redis");
    await c.set("k", { ok: true }, 5_000);
    expect(await c.get("k")).toEqual({ ok: true });
    await c.delete("k");
    expect(await c.get("k")).toBeUndefined();
    await c.close();
  });
});

describe("CachedProvider TTLs", () => {
  const TTL = { searchMs: 15 * 60_000, streamUrlMs: 6 * 3_600_000, trackMs: 6 * 3_600_000 };

  it("caches search results for 15 minutes", async () => {
    const clock = { t: 0 };
    const mock = new MockAudioProvider();
    const p = new CachedProvider(mock, new MemoryCache(1000, () => clock.t), TTL, () => clock.t);
    expect((await p.searchWithMeta("radiohead")).cached).toBe(false);
    clock.t = 15 * 60_000 - 1;
    expect((await p.searchWithMeta("  RadioHead ")).cached).toBe(true);
    clock.t = 15 * 60_000;
    expect((await p.searchWithMeta("radiohead")).cached).toBe(false);
    expect(mock.calls.search).toBe(2);
  });

  it("seeds track metadata from search hits", async () => {
    const mock = new MockAudioProvider();
    const p = new CachedProvider(mock, new MemoryCache(), TTL);
    const [hit] = await p.search("karma police");
    expect(await p.peekTrack(hit!.id)).toMatchObject({ title: "Karma Police" });
    await p.getTrackMetadata(hit!.id);
    expect(mock.calls.getTrackMetadata).toBe(0);
  });

  it("caches resolved stream URLs for 6 hours", async () => {
    const clock = { t: 0 };
    const mock = new MockAudioProvider();
    const p = new CachedProvider(mock, new MemoryCache(1000, () => clock.t), TTL, () => clock.t);
    const id = mock.catalog[0]!.id;
    await p.getStreamUrl(id);
    clock.t = 6 * 3_600_000 - 1;
    await p.getStreamUrl(id);
    expect(mock.calls.getStreamUrl).toBe(1);
    clock.t = 6 * 3_600_000;
    await p.getStreamUrl(id);
    expect(mock.calls.getStreamUrl).toBe(2);
  });

  it("never serves a signed URL that is about to expire", async () => {
    const clock = { t: 0 };
    const cache = new MemoryCache(1000, () => clock.t);
    const mock = new MockAudioProvider();
    vi.spyOn(mock, "getStreamUrl").mockImplementation(async () => ({ url: "https://cdn/x.flac", expiresAt: clock.t + 10 * 60_000 }));
    const p = new CachedProvider(mock, cache, TTL, () => clock.t);
    await p.getStreamUrl("demo-01");
    clock.t = 10 * 60_000 - URL_EXPIRY_SAFETY_MS - 1;
    await p.getStreamUrl("demo-01");
    expect(mock.getStreamUrl).toHaveBeenCalledTimes(1);
    clock.t += 2;
    await p.getStreamUrl("demo-01");
    expect(mock.getStreamUrl).toHaveBeenCalledTimes(2);
  });

  it("invalidateStream forces a fresh resolution", async () => {
    const mock = new MockAudioProvider();
    const p = new CachedProvider(mock, new MemoryCache(), TTL);
    const id = mock.catalog[0]!.id;
    await p.getStreamUrl(id);
    await p.invalidateStream(id);
    await p.getStreamUrl(id);
    expect(mock.calls.getStreamUrl).toBe(2);
  });
});
