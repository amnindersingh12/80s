import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SupabaseAuth } from "../src/auth/supabase.js";
import type { Env } from "../src/config.js";
import { AppError } from "../src/errors.js";
import { RemoteMediaProvider, expiryFromSignedUrl, parseExpiry } from "../src/providers/remote.js";
import type { JobProgress } from "../src/providers/types.js";
import { remoteConfig } from "./helpers/config.js";
import { startFakeUpstream, type FakeUpstream } from "./helpers/fakeUpstream.js";

let up: FakeUpstream;
const providers: RemoteMediaProvider[] = [];

function makeProvider(extra: Env = {}) {
  const { remote } = remoteConfig(up.url, extra);
  const auth = new SupabaseAuth({ ...remote.supabase, autoRefresh: false });
  const provider = new RemoteMediaProvider({ config: remote, auth });
  providers.push(provider);
  return { provider, auth, remote };
}

beforeEach(async () => {
  up = await startFakeUpstream();
});
afterEach(async () => {
  for (const p of providers.splice(0)) p.close();
  await up.close();
});

describe("RemoteMediaProvider — search", () => {
  it("sends the bearer token and the configured query param, and maps nested fields", async () => {
    const { provider } = makeProvider();
    const tracks = await provider.search("diljit");
    const call = up.state.searchCalls[0]!;
    expect(call.url.pathname).toBe("/api/search");
    expect(call.url.searchParams.get("q")).toBe("diljit");
    expect(call.auth).toBe("Bearer at-1");
    expect(tracks).toEqual([
      {
        id: "t1",
        provider: "remote",
        title: "Lover",
        artist: "Diljit Dosanjh",
        album: "MoonChild Era",
        durationSec: 182,
        format: "flac",
        lossless: true,
        bitDepth: 24,
        sampleRate: 96000,
      },
      { id: "t2", provider: "remote", title: "Excuses", artist: "AP Dhillon, Gurinder Gill", durationSec: 176, format: "flac", lossless: true },
    ]);
  });

  it("honours custom paths, params, results path and MEDIA_FIELD_MAP", async () => {
    up.state.searchResponse = {
      payload: { hits: [{ uid: "x9", name: "Softly", performer: "Karan Aujla", secs: 151, codec: "mp3" }] },
    };
    const { provider } = makeProvider({
      MEDIA_SEARCH_PARAM: "term",
      MEDIA_SEARCH_LIMIT_PARAM: "max",
      MEDIA_SEARCH_EXTRA_PARAMS: "type=track&quality=lossless",
      MEDIA_SEARCH_RESULTS_PATH: "payload.hits",
      MEDIA_FIELD_MAP: JSON.stringify({ id: "uid", title: "name", artist: "performer", durationSec: "secs", format: "codec" }),
    });
    const tracks = await provider.search("softly", { limit: 5 });
    const q = up.state.searchCalls[0]!.url.searchParams;
    expect(q.get("term")).toBe("softly");
    expect(q.get("max")).toBe("5");
    expect(q.get("type")).toBe("track");
    expect(q.get("quality")).toBe("lossless");
    expect(tracks).toEqual([
      { id: "x9", provider: "remote", title: "Softly", artist: "Karan Aujla", durationSec: 151, format: "mp3", lossless: false },
    ]);
  });

  it("re-authenticates once when the media API answers 401", async () => {
    const { provider } = makeProvider();
    await provider.search("a"); // sign in
    up.state.rejectNextMediaRequests = 1;
    await provider.search("b");
    expect(up.state.authCalls.map((c) => c.grant)).toEqual(["password", "refresh_token"]);
    expect(up.state.searchCalls.at(-1)!.auth).toBe("Bearer at-2");
  });

  it("times out a stalled search after MEDIA_REQUEST_TIMEOUT_MS with a 504", async () => {
    up.state.searchDelayMs = 5_000;
    const { provider } = makeProvider({ MEDIA_REQUEST_TIMEOUT_MS: "150" });
    const started = Date.now();
    const err = await provider.search("slow").catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "UPSTREAM_TIMEOUT", status: 504 });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("looks up metadata through MEDIA_TRACK_PATH when configured", async () => {
    const { provider } = makeProvider({ MEDIA_TRACK_PATH: "/api/tracks/:id" });
    expect(await provider.getTrackMetadata("t1")).toMatchObject({ id: "t1", title: "Lover", artist: "Diljit Dosanjh" });
    expect(await provider.getTrackMetadata("nope")).toBeNull();
  });
});

describe("RemoteMediaProvider — async jobs", () => {
  it("creates a job with the configured track-id field, polls it and returns the signed URL", async () => {
    const { provider } = makeProvider({ MEDIA_JOB_EXTRA_BODY: '{"quality":"LOSSLESS"}' });
    const progress: JobProgress[] = [];
    const source = await provider.getStreamUrl("t1", { onProgress: (p) => progress.push(p) });
    expect(up.state.jobCreateBodies).toEqual([{ quality: "LOSSLESS", trackId: "t1" }]);
    expect(source.url).toBe(up.state.signedUrlFor("t1"));
    expect(source.mimeType).toBe("audio/flac");
    expect(source.extension).toBe("flac");
    expect(source.expiresAt).toBe(Date.UTC(2099, 11, 31) + 3600_000);
    expect(progress[0]).toEqual({ stage: "queued" });
    expect(progress.some((p) => p.stage === "uploading" && p.progress === 0.5)).toBe(true);
  });

  it("uses a custom MEDIA_TRACK_ID_FIELD and status path", async () => {
    up.state.jobStatusOverride = (job) => ({ state: "done", result: { url: `/files/${job.trackId}.flac` } });
    const { provider } = makeProvider({ MEDIA_TRACK_ID_FIELD: "trackId", MEDIA_JOB_STATUS_PATH: "/api/jobs/:jobId" });
    const source = await provider.getStreamUrl("t9");
    // relative URLs are resolved against MEDIA_API_BASE and get the bearer token attached
    expect(source.url).toBe(`${up.url}/files/t9.flac`);
    expect(await provider.authorizeStream(source)).toEqual({ authorization: expect.stringMatching(/^Bearer at-/) });
    expect(await provider.authorizeStream({ url: "https://cdn.example/x.flac" })).toEqual({});
  });

  it("skips polling when the create call already returns a URL (upstream cache hit)", async () => {
    up.state.jobCreateResponse = (trackId) => ({ status: "completed", url: up.state.signedUrlFor(trackId) });
    const { provider } = makeProvider();
    await provider.getStreamUrl("t1");
    expect([...up.state.jobs.values()].every((j) => j.polls === 0)).toBe(true);
  });

  it("retries a transient 5xx on the status endpoint once", async () => {
    up.state.failNextPolls = 1;
    const { provider } = makeProvider();
    await expect(provider.getStreamUrl("t1")).resolves.toMatchObject({ extension: "flac" });
  });

  it("returns a clean 503 when the status endpoint keeps failing", async () => {
    up.state.failNextPolls = 2;
    const { provider } = makeProvider({ MEDIA_JOB_RETRIES: "1" });
    const err = await provider.getStreamUrl("t1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", status: 503, upstreamStatus: 500 });
  });

  it("bounds a job that never finishes by MEDIA_JOB_MAX_WAIT_MS → 504 JOB_TIMEOUT", async () => {
    up.state.pollsUntilDone = Number.POSITIVE_INFINITY;
    const { provider } = makeProvider({ MEDIA_JOB_MAX_WAIT_MS: "250", MEDIA_JOB_POLL_INTERVAL_MS: "20" });
    const started = Date.now();
    const err = await provider.getStreamUrl("t1").catch((e: unknown) => e);
    const elapsed = Date.now() - started;
    expect(err).toMatchObject({ code: "JOB_TIMEOUT", status: 504 });
    expect(elapsed).toBeGreaterThanOrEqual(230);
    expect(elapsed).toBeLessThan(1_000);
    expect(up.state.jobs.get("job-1")!.polls).toBeGreaterThan(3);
  });

  it("does not hang when a status request stalls (per-request timeout + retry, still bounded)", async () => {
    up.state.hangNextPolls = 10;
    const { provider } = makeProvider({ MEDIA_REQUEST_TIMEOUT_MS: "80", MEDIA_JOB_MAX_WAIT_MS: "400" });
    const started = Date.now();
    const err = await provider.getStreamUrl("t1").catch((e: unknown) => e);
    expect((err as AppError).status).toBe(504);
    expect(Date.now() - started).toBeLessThan(1_200);
  });

  it("maps a failed job to 502 JOB_FAILED with the upstream reason", async () => {
    up.state.jobStatusOverride = () => ({ status: "failed", error: { message: "R2 upload rejected" } });
    const { provider } = makeProvider();
    await expect(provider.getStreamUrl("t1")).rejects.toMatchObject({
      code: "JOB_FAILED",
      status: 502,
      message: expect.stringContaining("R2 upload rejected"),
    });
  });

  it("maps an unknown track to 404", async () => {
    const { provider } = makeProvider();
    await expect(provider.getStreamUrl("missing")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("never runs more than MEDIA_JOB_CONCURRENCY (2) jobs at once", async () => {
    up.state.pollsUntilDone = 3;
    const { provider } = makeProvider({ MEDIA_JOB_CONCURRENCY: "2", MEDIA_JOB_POLL_INTERVAL_MS: "15" });
    const results = await Promise.all(["a", "b", "c", "d", "e", "f"].map((id) => provider.getStreamUrl(id)));
    expect(results).toHaveLength(6);
    expect(up.state.peakActiveJobs).toBe(2);
    expect(provider.semaphore.peak).toBe(2);
    expect(up.state.jobCreateBodies).toHaveLength(6);
  });

  it("gives up waiting for a job slot after MEDIA_JOB_QUEUE_TIMEOUT_MS → 503 PROVIDER_BUSY", async () => {
    up.state.pollsUntilDone = Number.POSITIVE_INFINITY;
    const { provider } = makeProvider({
      MEDIA_JOB_CONCURRENCY: "1",
      MEDIA_JOB_MAX_WAIT_MS: "500",
      MEDIA_JOB_QUEUE_TIMEOUT_MS: "100",
    });
    const first = provider.getStreamUrl("a").catch((e: unknown) => e);
    const second = await provider.getStreamUrl("b").catch((e: unknown) => e);
    expect(second).toMatchObject({ code: "PROVIDER_BUSY", status: 503 });
    expect(await first).toMatchObject({ code: "JOB_TIMEOUT" });
  });
});

describe("signed URL expiry parsing", () => {
  it("reads AWS SigV4 (R2/S3) and legacy Expires params", () => {
    expect(expiryFromSignedUrl("https://x.r2.cloudflarestorage.com/a.flac?X-Amz-Date=20260101T000000Z&X-Amz-Expires=600")).toBe(
      Date.UTC(2026, 0, 1) + 600_000,
    );
    expect(expiryFromSignedUrl("https://cdn.example/a.flac?Expires=1900000000")).toBe(1_900_000_000_000);
    expect(expiryFromSignedUrl("https://cdn.example/a.flac")).toBeUndefined();
  });

  it("accepts ISO strings, epoch seconds and epoch ms", () => {
    expect(parseExpiry("2030-01-01T00:00:00Z")).toBe(Date.UTC(2030, 0, 1));
    expect(parseExpiry(1_900_000_000)).toBe(1_900_000_000_000);
    expect(parseExpiry(1_900_000_000_000)).toBe(1_900_000_000_000);
    expect(parseExpiry("nope")).toBeUndefined();
  });
});
