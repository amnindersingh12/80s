import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_JOB_FIELDS, loadConfig } from "../src/config.js";

const base = {
  MEDIA_API_BASE: "https://media.example.com/",
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_ANON_KEY: "anon",
  MEDIA_USER_EMAIL: "me@example.com",
  MEDIA_USER_PASSWORD: "pw",
};

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const c = loadConfig(base);
    expect(c.demo).toBe(false);
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(8787);
    expect(c.remote).toMatchObject({
      baseUrl: "https://media.example.com",
      searchPath: "/api/search",
      searchParam: "q",
      jobCreatePath: "/api/download",
      jobCreateMethod: "POST",
      trackIdField: "trackId",
      jobStatusPath: "/api/jobs/:jobId",
      requestTimeoutMs: 15_000,
      pollIntervalMs: 2_000,
      maxJobWaitMs: 45_000,
      jobRetries: 1,
      jobConcurrency: 2,
      streamAuth: "auto",
    });
    expect(c.remote?.supabase).toMatchObject({ refreshMarginMs: 60_000, timeoutMs: 15_000 });
    expect(c.cacheTtl).toEqual({ searchMs: 900_000, streamUrlMs: 21_600_000, trackMs: 21_600_000 });
    expect(c.recommendations.lastfm).toBeUndefined();
    expect(c.recommendations.listenbrainz?.baseUrl).toBe("https://api.listenbrainz.org");
  });

  it("enables demo mode automatically when no provider is configured", () => {
    expect(loadConfig({}).demo).toBe(true);
    expect(loadConfig({ ...base, DEMO_MODE: "true" }).demo).toBe(true);
  });

  it("accepts a refresh token instead of a password", () => {
    const c = loadConfig({ ...base, MEDIA_USER_EMAIL: "", MEDIA_USER_PASSWORD: "", MEDIA_REFRESH_TOKEN: "rt" });
    expect(c.remote?.supabase.refreshToken).toBe("rt");
  });

  it("collects every problem in one error", () => {
    try {
      loadConfig({ MEDIA_API_BASE: "ftp://nope", SUPABASE_URL: "https://x" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const msg = (err as ConfigError).message;
      expect(msg).toContain("MEDIA_API_BASE must be an absolute http(s) URL");
      expect(msg).toContain("MEDIA_API_BASE is required");
    }
    expect(() => loadConfig({ ...base, MEDIA_USER_PASSWORD: undefined })).toThrow(/MEDIA_USER_EMAIL \+ MEDIA_USER_PASSWORD/);
    expect(() => loadConfig({ ...base, SUPABASE_ANON_KEY: "" })).toThrow(/SUPABASE_ANON_KEY is required/);
    expect(() => loadConfig({ ...base, MEDIA_JOB_POLL_INTERVAL_MS: "fast" })).toThrow(/MEDIA_JOB_POLL_INTERVAL_MS/);
  });

  it("merges JSON field maps and rejects unknown keys", () => {
    const c = loadConfig({ ...base, MEDIA_JOB_FIELD_MAP: '{"url":"data.signed"}', MEDIA_FIELD_MAP: '{"title":"song_name"}' });
    expect(c.remote?.jobFields).toEqual({ ...DEFAULT_JOB_FIELDS, url: "data.signed" });
    expect(c.remote?.trackFields.title).toBe("song_name");
    expect(() => loadConfig({ ...base, MEDIA_FIELD_MAP: '{"colour":"x"}' })).toThrow(/unknown field "colour"/);
    expect(() => loadConfig({ ...base, MEDIA_FIELD_MAP: "{nope" })).toThrow(/must be a JSON object/);
  });

  it("normalises paths and parses lists", () => {
    const c = loadConfig({
      ...base,
      MEDIA_SEARCH_PATH: "v2/find",
      MEDIA_JOB_SUCCESS_STATES: "Ready, Uploaded",
      MEDIA_JOB_CREATE_METHOD: "put",
    });
    expect(c.remote?.searchPath).toBe("/v2/find");
    expect(c.remote?.jobSuccessStates).toEqual(["ready", "uploaded"]);
    expect(c.remote?.jobCreateMethod).toBe("PUT");
  });

  it("requires credentials for the Subsonic fallback", () => {
    expect(() => loadConfig({ ...base, SUBSONIC_URL: "https://navidrome.local" })).toThrow(/SUBSONIC_API_KEY/);
    const c = loadConfig({ ...base, SUBSONIC_URL: "https://navidrome.local", SUBSONIC_API_KEY: "k" });
    expect(c.subsonic).toMatchObject({ baseUrl: "https://navidrome.local", apiKey: "k", client: "80s-web" });
  });
});
