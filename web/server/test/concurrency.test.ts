import { describe, expect, it } from "vitest";
import { AsyncLock, IntervalLimiter, Semaphore, SingleFlight, mapLimit } from "../src/lib/concurrency.js";
import { MemoryCache } from "../src/lib/cache.js";
import { CachedProvider } from "../src/providers/cached.js";
import { MockAudioProvider } from "../src/providers/mock.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Semaphore", () => {
  it("limits concurrency to the configured number of slots", async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        sem.use(async () => {
          active++;
          peak = Math.max(peak, active);
          await wait(10);
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(sem.peak).toBe(2);
    expect(sem.inUse).toBe(0);
  });

  it("grants slots in FIFO order", async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    await Promise.all([1, 2, 3, 4].map((n) => sem.use(async () => { order.push(n); await wait(2); })));
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("rejects waiters after the queue timeout with PROVIDER_BUSY and frees their place", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    await expect(sem.acquire({ timeoutMs: 30 })).rejects.toMatchObject({ code: "PROVIDER_BUSY", status: 503 });
    expect(sem.pending).toBe(0);
    release();
    const again = await sem.acquire({ timeoutMs: 30 });
    again();
  });

  it("supports aborting a queued acquire", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    const ac = new AbortController();
    const p = sem.acquire({ signal: ac.signal });
    ac.abort(new Error("cancelled"));
    await expect(p).rejects.toThrow("cancelled");
    release();
    expect(sem.inUse).toBe(0);
  });

  it("ignores double release", async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    release();
    release();
    expect(sem.inUse).toBe(0);
  });
});

describe("AsyncLock / SingleFlight / mapLimit / IntervalLimiter", () => {
  it("AsyncLock serialises critical sections", async () => {
    const lock = new AsyncLock();
    const log: string[] = [];
    await Promise.all(["a", "b", "c"].map((k) => lock.run(async () => { log.push(`${k}+`); await wait(5); log.push(`${k}-`); })));
    expect(log).toEqual(["a+", "a-", "b+", "b-", "c+", "c-"]);
  });

  it("SingleFlight coalesces concurrent calls per key", async () => {
    const sf = new SingleFlight<number>();
    let calls = 0;
    const fn = async () => { calls++; await wait(10); return 42; };
    const results = await Promise.all([sf.run("k", fn), sf.run("k", fn), sf.run("other", fn)]);
    expect(results).toEqual([42, 42, 42]);
    expect(calls).toBe(2);
  });

  it("mapLimit keeps order and respects the limit", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await wait(n * 2);
      active--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });

  it("IntervalLimiter spaces calls", async () => {
    const limiter = new IntervalLimiter(40);
    const starts: number[] = [];
    await Promise.all([1, 2, 3].map(() => limiter.schedule(async () => { starts.push(Date.now()); })));
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(35);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(35);
  });
});

describe("CachedProvider concurrency", () => {
  it("triggers one upstream job for many simultaneous plays of the same track", async () => {
    const mock = new MockAudioProvider({ latencyMs: 30 });
    const cached = new CachedProvider(mock, new MemoryCache(), { searchMs: 1, streamUrlMs: 60_000, trackMs: 1 });
    const id = mock.catalog[0]!.id;
    const sources = await Promise.all(Array.from({ length: 10 }, () => cached.getStreamUrl(id)));
    expect(new Set(sources.map((s) => s.url)).size).toBe(1);
    expect(mock.calls.getStreamUrl).toBe(1);
    await cached.getStreamUrl(id);
    expect(mock.calls.getStreamUrl).toBe(1); // cached afterwards
  });
});
