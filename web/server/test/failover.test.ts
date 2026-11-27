import { afterEach, describe, expect, it } from "vitest";
import { SupabaseAuth } from "../src/auth/supabase.js";
import { AppError } from "../src/errors.js";
import { MemoryCache } from "../src/lib/cache.js";
import { CachedProvider } from "../src/providers/cached.js";
import { ProviderChain, parsePublicId } from "../src/providers/chain.js";
import { MockAudioProvider } from "../src/providers/mock.js";
import { RemoteMediaProvider } from "../src/providers/remote.js";
import type { AudioProvider } from "../src/providers/types.js";
import { remoteConfig } from "./helpers/config.js";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fakeUpstream.js";

const TTL = { searchMs: 900_000, streamUrlMs: 21_600_000, trackMs: 21_600_000 };

const PRIMARY_TRACKS = [
  { id: "p1", title: "Karma Police", artist: "Radiohead", durationSec: 264, lossless: true },
  { id: "p2", title: "Brown Munde", artist: "AP Dhillon", durationSec: 267, lossless: true },
];
const FALLBACK_TRACKS = [
  { id: "f-77", title: "Karma Police (Remastered)", artist: "Radiohead", durationSec: 263, lossless: true, format: "flac" },
  { id: "f-78", title: "No Surprises", artist: "Radiohead", durationSec: 229, lossless: true, format: "flac" },
];

function build(primary: AudioProvider, fallback?: AudioProvider, opts: { cooldownMs?: number; clock?: { t: number } } = {}) {
  const cache = new MemoryCache();
  const now = opts.clock ? () => opts.clock!.t : Date.now;
  const events: string[] = [];
  const chain = new ProviderChain(
    new CachedProvider(primary, cache, TTL, now),
    fallback ? new CachedProvider(fallback, cache, TTL, now) : undefined,
    { cooldownMs: opts.cooldownMs ?? 30_000, now, onFailover: (e) => events.push(`${e.op}:${e.from}->${e.to}:${e.error.code}`) },
  );
  return { chain, events };
}

const timeout = () => new AppError("UPSTREAM_TIMEOUT", "primary timed out", { provider: "remote" });

describe("ProviderChain failover", () => {
  it("routes public ids by provider prefix", async () => {
    const primary = new MockAudioProvider({ name: "remote", tracks: PRIMARY_TRACKS });
    const fallback = new MockAudioProvider({ name: "subsonic", tracks: FALLBACK_TRACKS });
    const { chain } = build(primary, fallback);
    expect(parsePublicId("subsonic:a:b")).toEqual({ provider: "subsonic", rawId: "a:b" });
    const r = await chain.resolveStream("subsonic:f-78");
    expect(r.servedBy.name).toBe("subsonic");
    expect(primary.calls.getStreamUrl).toBe(0);
    await expect(chain.resolveStream("nope:1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(chain.resolveStream("missing-colon")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("falls back to the secondary provider when primary search times out", async () => {
    const primary = new MockAudioProvider({ name: "remote", tracks: PRIMARY_TRACKS }).fail("search", timeout);
    const fallback = new MockAudioProvider({ name: "subsonic", tracks: FALLBACK_TRACKS });
    const { chain, events } = build(primary, fallback);
    const res = await chain.search("karma police");
    expect(res).toMatchObject({ provider: "subsonic", fallback: true });
    expect(res.tracks[0]!.id).toBe("subsonic:f-77");
    expect(events).toEqual(["search:remote->subsonic:UPSTREAM_TIMEOUT"]);
  });

  it("does not fail over on errors that are about the request, not the provider", async () => {
    const primary = new MockAudioProvider({ name: "remote" }).fail("search", new AppError("UPSTREAM_BAD_RESPONSE", "bad json"));
    const fallback = new MockAudioProvider({ name: "subsonic", tracks: FALLBACK_TRACKS });
    const { chain } = build(primary, fallback);
    await expect(chain.search("x")).rejects.toMatchObject({ code: "UPSTREAM_BAD_RESPONSE" });
    expect(fallback.calls.search).toBe(0);
  });

  it("surfaces the primary error when there is no fallback", async () => {
    const primary = new MockAudioProvider({ name: "remote" }).fail("search", timeout);
    const { chain } = build(primary);
    await expect(chain.search("x")).rejects.toMatchObject({ code: "UPSTREAM_TIMEOUT", status: 504 });
  });

  it("streams a primary track from the fallback when its job times out (cross-provider match)", async () => {
    const primary = new MockAudioProvider({ name: "remote", tracks: PRIMARY_TRACKS });
    const fallback = new MockAudioProvider({ name: "subsonic", tracks: FALLBACK_TRACKS });
    const { chain, events } = build(primary, fallback);
    await chain.search("karma police"); // primary search caches p1's metadata
    primary.fail("getStreamUrl", new AppError("JOB_TIMEOUT", "still packaging"));

    const r = await chain.resolveStream("remote:p1");
    expect(r).toMatchObject({ fallback: true, servedId: "f-77" });
    expect(r.servedBy.name).toBe("subsonic");
    expect(events).toEqual(["stream:remote->subsonic:JOB_TIMEOUT"]);
  });

  it("rethrows the primary error when the fallback has no matching recording", async () => {
    const primary = new MockAudioProvider({ name: "remote", tracks: PRIMARY_TRACKS });
    const fallback = new MockAudioProvider({ name: "subsonic", tracks: FALLBACK_TRACKS });
    const { chain } = build(primary, fallback);
    await chain.search("brown munde");
    primary.fail("getStreamUrl", new AppError("JOB_TIMEOUT", "still packaging"));
    await expect(chain.resolveStream("remote:p2")).rejects.toMatchObject({ code: "JOB_TIMEOUT", status: 504 });
  });

  it("opens a circuit after a failure so the next calls skip the slow primary, then recovers", async () => {
    const clock = { t: 1_000 };
    const primary = new MockAudioProvider({ name: "remote", tracks: PRIMARY_TRACKS }).fail("search", timeout);
    const fallback = new MockAudioProvider({ name: "subsonic", tracks: FALLBACK_TRACKS });
    const { chain } = build(primary, fallback, { cooldownMs: 10_000, clock });

    await chain.search("radiohead");
    expect(chain.circuitOpen).toBe(true);
    expect(chain.health()[0]).toMatchObject({ circuit: "open", lastError: "primary timed out" });

    await chain.search("no surprises");
    expect(primary.calls.search).toBe(1); // skipped while open

    clock.t += 10_001;
    primary.fail("search"); // primary healthy again
    const res = await chain.search("karma");
    expect(res.provider).toBe("remote");
    expect(chain.circuitOpen).toBe(false);
  });

  it("serves a primary stream from the fallback straight away while the circuit is open", async () => {
    const primary = new MockAudioProvider({ name: "remote", tracks: PRIMARY_TRACKS });
    const fallback = new MockAudioProvider({ name: "subsonic", tracks: FALLBACK_TRACKS });
    const { chain } = build(primary, fallback);
    await chain.search("karma");
    primary.fail("search", timeout);
    await chain.search("anything"); // trips the circuit
    const r = await chain.resolveStream("remote:p1");
    expect(r.fallback).toBe(true);
    expect(primary.calls.getStreamUrl).toBe(0);
  });

  describe("end to end with a stalled RemoteMediaProvider", () => {
    let up: FakeUpstream;
    afterEach(async () => up?.close());

    it("fails over to the fallback when the real primary times out", async () => {
      up = await startFakeUpstream({ searchDelayMs: 5_000 });
      const { remote } = remoteConfig(up.url, { MEDIA_REQUEST_TIMEOUT_MS: "120" });
      const primary = new RemoteMediaProvider({ config: remote, auth: new SupabaseAuth({ ...remote.supabase, autoRefresh: false }) });
      const fallback = new MockAudioProvider({ name: "subsonic", tracks: FALLBACK_TRACKS });
      const { chain } = build(primary, fallback);
      const started = Date.now();
      const res = await chain.search("karma police");
      expect(res.fallback).toBe(true);
      expect(res.tracks.length).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(2_000);
      primary.close();
    });
  });
});
