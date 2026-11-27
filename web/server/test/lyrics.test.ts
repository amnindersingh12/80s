import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryCache } from "../src/lib/cache.js";
import { createServices } from "../src/services.js";
import { clearLyricsCache, fetchLyrics } from "../src/services/lyrics.js";
import { demoConfig } from "./helpers/config.js";

afterEach(() => {
  clearLyricsCache();
});

describe("LRCLIB lyrics service & /api/lyrics route", () => {
  it("fetches exact synced lyrics from LRCLIB with required User-Agent and caches them", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("user-agent")).toContain("80s-player/");
      return new Response(
        JSON.stringify({
          trackName: "Karma Police",
          artistName: "Radiohead",
          instrumental: false,
          syncedLyrics: "[00:12.00] Karma police\n[00:16.00] Arrest this man",
          plainLyrics: "Karma police\nArrest this man",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const r1 = await fetchLyrics({ track: "Karma Police", artist: "Radiohead", durationSec: 264 }, { fetch: fetchMock });
    expect(r1).toEqual({
      syncedLyrics: "[00:12.00] Karma police\n[00:16.00] Arrest this man",
      plainLyrics: "Karma police\nArrest this man",
      instrumental: false,
      source: "lrclib",
    });

    const r2 = await fetchLyrics({ track: "Karma Police", artist: "Radiohead" }, { fetch: fetchMock });
    expect(r2).toEqual(r1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to /api/search when /api/get returns 404", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const u = String(input);
      if (u.includes("/api/get")) return new Response("Not found", { status: 404 });
      return new Response(
        JSON.stringify([
          { trackName: "Lover", artistName: "Diljit Dosanjh", plainLyrics: "Plain only", syncedLyrics: null },
          { trackName: "Lover", artistName: "Diljit Dosanjh", syncedLyrics: "[00:05.00] Synced line", plainLyrics: "Plain line" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const r = await fetchLyrics({ track: "Lover", artist: "Diljit Dosanjh" }, { fetch: fetchMock });
    expect(r).toEqual({
      syncedLyrics: "[00:05.00] Synced line",
      plainLyrics: "Plain line",
      instrumental: false,
      source: "lrclib",
    });
  });

  it("degrades gracefully to source: none when upstream errors", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const r = await fetchLyrics({ track: "Creep", artist: "Radiohead" }, { fetch: fetchMock });
    expect(r).toEqual({ syncedLyrics: null, plainLyrics: null, instrumental: false, source: "none" });
  });

  it("exposes GET /api/lyrics on the Fastify app", async () => {
    const config = demoConfig({});
    const services = await createServices(config, { cache: new MemoryCache() });
    const app = await buildApp({ config, services });
    await app.ready();
    try {
      const res = await app.inject("/api/lyrics");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ syncedLyrics: null, plainLyrics: null, instrumental: false, source: "none" });
    } finally {
      await app.close();
    }
  });
});
