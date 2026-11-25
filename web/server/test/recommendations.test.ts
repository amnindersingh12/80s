import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryCache } from "../src/lib/cache.js";
import { CachedProvider } from "../src/providers/cached.js";
import { ProviderChain } from "../src/providers/chain.js";
import { MockAudioProvider } from "../src/providers/mock.js";
import { RecommendationEngine, diversify, expandTag, primaryArtist } from "../src/recommendations/engine.js";
import { LastfmClient } from "../src/recommendations/lastfm.js";
import { ListenBrainzClient } from "../src/recommendations/listenbrainz.js";
import { MusicBrainzClient } from "../src/recommendations/musicbrainz.js";
import { createServices } from "../src/services.js";
import { demoConfig } from "./helpers/config.js";

const RADIOHEAD = "a74b1b7f-71a5-4011-9441-d0b5e4122711";
const ARCTIC = "ada7a83c-e3e1-40f1-93f9-3e73dbc9298a";

type Route = (url: URL) => unknown;

/** Routes fake responses by host + path so each source can be stubbed or broken independently. */
function fakeFetch(routes: Record<string, Route>) {
  const seen: URL[] = [];
  const fn = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    seen.push(url);
    const key = Object.keys(routes).find((k) => `${url.host}${url.pathname}`.startsWith(k) || url.searchParams.get("method") === k);
    if (!key) return new Response("{}", { status: 404 });
    const body = routes[key]!(url);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fn: fn as unknown as typeof fetch, seen };
}

const lastfmRoutes: Record<string, Route> = {
  "track.getSimilar": () => ({
    similartracks: {
      track: [
        { name: "No Surprises", match: 1, artist: { name: "Radiohead" }, duration: 229 },
        { name: "Do I Wanna Know?", match: 0.8, artist: { name: "Arctic Monkeys" } },
        { name: "Imaginary Song", match: 0.7, artist: { name: "Nobody Band" } },
        { name: "Karma Police", match: 0.6, artist: { name: "Radiohead" } }, // the seed itself
        { name: "Exit Music (For a Film)", match: 0.5, artist: { name: "Radiohead" } },
        { name: "Let Down", match: 0.45, artist: { name: "Radiohead" } },
      ],
    },
  }),
  "artist.getSimilar": () => ({
    similarartists: {
      artist: [
        { name: "Arctic Monkeys", match: "0.9", image: [{ "#text": "https://lastfm.freetls.fastly.net/i/u/300x300/2a96cbd8b46e442fc41c2b86b821562f.png", size: "extralarge" }] },
        { name: "Thom Yorke", match: "0.8" },
      ],
    },
  }),
  "artist.getTopTags": () => ({ toptags: { tag: [{ name: "Alternative" }, { name: "rock" }] } }),
  "artist.getTopTracks": (u) => ({
    toptracks: { track: [{ name: `${u.searchParams.get("artist")} Hit`, artist: { name: u.searchParams.get("artist") } }] },
  }),
  "tag.getTopTracks": (u) =>
    u.searchParams.get("tag") === "punjabi pop"
      ? { tracks: { track: [] } }
      : { tracks: { track: [{ name: "Brown Munde", artist: { name: "AP Dhillon" } }, { name: "Lover", artist: { name: "Diljit Dosanjh" } }] } },
  "tag.getTopArtists": () => ({ topartists: { artist: [{ name: "AP Dhillon" }, { name: "Diljit Dosanjh" }] } }),
};

const lbRoutes: Record<string, Route> = {
  [`api.listenbrainz.org/1/lb-radio/artist/${RADIOHEAD}`]: () => ({
    [RADIOHEAD]: [{ recording_mbid: "rec-ns", similar_artist_mbid: RADIOHEAD, similar_artist_name: "Radiohead" }],
    [ARCTIC]: [{ recording_mbid: "rec-dwk", similar_artist_mbid: ARCTIC, similar_artist_name: "Arctic Monkeys" }],
  }),
  "labs.api.listenbrainz.org/similar-artists/json": () => [
    { artist_mbid: ARCTIC, name: "Arctic Monkeys", score: 900 },
    { artist_mbid: "mbid-thom", name: "Thom Yorke", score: 800 },
  ],
  "api.listenbrainz.org/1/lb-radio/tags": () => [{ recording_mbid: "rec-295" }, { recording_mbid: "rec-weroll" }],
  "api.listenbrainz.org/1/metadata/recording": () => ({
    "rec-ns": { recording: { name: "No Surprises", length: 229000 }, artist: { name: "Radiohead" }, release: { name: "OK Computer", caa_release_mbid: "rel-ok", caa_id: 1 } },
    "rec-dwk": { recording: { name: "Do I Wanna Know?", length: 272000 }, artist: { name: "Arctic Monkeys" }, release: { name: "AM" } },
    "rec-295": { recording: { name: "295" }, artist: { name: "Sidhu Moose Wala" } },
    "rec-weroll": { recording: { name: "We Rollin" }, artist: { name: "Shubh" } },
  }),
};

const mbRoutes: Record<string, Route> = {
  "musicbrainz.org/ws/2/artist/": () => ({ id: RADIOHEAD, name: "Radiohead", genres: [{ name: "alternative rock", count: 20 }, { name: "art rock", count: 9 }] }),
  "musicbrainz.org/ws/2/artist": () => ({ artists: [{ id: RADIOHEAD, name: "Radiohead", score: 100 }] }),
  "musicbrainz.org/ws/2/recording": () => ({ recordings: [{ id: "mb-1", title: "Softly", "artist-credit": [{ name: "Karan Aujla" }] }] }),
};

function engineWith(routes: Record<string, Route>, opts: { lastfm?: boolean; lb?: boolean; mb?: boolean } = {}) {
  const { fn, seen } = fakeFetch(routes);
  const mock = new MockAudioProvider({ name: "demo" });
  const cache = new MemoryCache();
  const ttl = { searchMs: 60_000, streamUrlMs: 60_000, trackMs: 60_000 };
  const chain = new ProviderChain(new CachedProvider(mock, cache, ttl));
  const engine = new RecommendationEngine({
    chain,
    cache,
    cacheTtlMs: 60_000,
    matchConcurrency: 3,
    lastfm: opts.lastfm === false ? undefined : new LastfmClient({ apiKey: "k", baseUrl: "https://ws.audioscrobbler.com/2.0", timeoutMs: 1_000, fetch: fn }),
    listenbrainz: opts.lb === false ? undefined : new ListenBrainzClient({ baseUrl: "https://api.listenbrainz.org", timeoutMs: 1_000, fetch: fn }),
    musicbrainz: opts.mb === false ? undefined : new MusicBrainzClient({ baseUrl: "https://musicbrainz.org/ws/2", userAgent: "test/1 ( test )", timeoutMs: 1_000, fetch: fn, intervalMs: 0 }),
  });
  return { engine, mock, seen };
}

describe("RecommendationEngine", () => {
  it("merges Last.fm + ListenBrainz for a track seed and marks playable vs metadata-only", async () => {
    const { engine } = engineWith({ ...lastfmRoutes, ...lbRoutes, ...mbRoutes });
    const rec = await engine.recommend({ type: "track", artist: "Radiohead", title: "Karma Police" });

    expect(rec.seed).toMatchObject({ type: "track", label: "Karma Police — Radiohead" });
    expect(rec.sources).toEqual({ lastfm: "ok", listenbrainz: "ok", musicbrainz: "ok" });

    const keys = rec.relatedTracks.map((t) => t.key);
    expect(keys).not.toContain("radiohead|karma police"); // seed excluded
    const ns = rec.relatedTracks.find((t) => t.title === "No Surprises")!;
    expect(ns.sources.sort()).toEqual(["lastfm", "listenbrainz"]); // deduped across sources
    expect(ns.score).toBe(1);
    expect(ns.availability).toBe("playable");
    expect(ns.track).toMatchObject({ id: "demo:demo-13", provider: "demo" });

    const imaginary = rec.relatedTracks.find((t) => t.title === "Imaginary Song")!;
    expect(imaginary.availability).toBe("metadata-only");
    expect(imaginary.track).toBeUndefined();

    // at most two tracks per artist before others get a turn
    const firstFour = rec.relatedTracks.slice(0, 4).map((t) => t.artist);
    expect(firstFour.filter((a) => a === "Radiohead").length).toBeLessThanOrEqual(2);

    expect(rec.similarArtists[0]).toMatchObject({ name: "Arctic Monkeys", playable: true });
    expect(rec.similarArtists[0]!.imageUrl).toBeUndefined(); // Last.fm placeholder dropped
    expect(rec.similarArtists.find((a) => a.name === "Thom Yorke")).toMatchObject({ playable: false });
    expect(rec.tags).toEqual(expect.arrayContaining(["alternative", "alternative rock"]));
  });

  it("expands regional/genre tags (Punjabi pop) and still finds playable tracks", async () => {
    const { engine, seen } = engineWith({ ...lastfmRoutes, ...lbRoutes, ...mbRoutes });
    const rec = await engine.recommend({ type: "tag", tag: "Punjabi Pop" });
    expect(rec.seed.label).toBe("Punjabi Pop");
    const lbTags = seen.find((u) => u.pathname === "/1/lb-radio/tags")!.searchParams.getAll("tag");
    expect(lbTags).toEqual(expect.arrayContaining(["punjabi", "bhangra", "punjabi pop"]));
    // Last.fm had no chart for the phrase → retried with the first alias
    expect(seen.filter((u) => u.searchParams.get("method") === "tag.getTopTracks").map((u) => u.searchParams.get("tag"))).toEqual([
      "punjabi pop",
      "punjabi",
    ]);
    const playable = rec.relatedTracks.filter((t) => t.availability === "playable").map((t) => t.title);
    expect(playable).toEqual(expect.arrayContaining(["Brown Munde", "Lover", "295", "We Rollin"]));
    expect(rec.similarArtists.map((a) => a.name)).toEqual(expect.arrayContaining(["AP Dhillon", "Diljit Dosanjh"]));
  });

  it("returns partial results with warnings when a source is down", async () => {
    const { engine } = engineWith({
      ...lbRoutes,
      ...mbRoutes,
      "track.getSimilar": () => new Response("upstream exploded", { status: 500 }),
      "artist.getSimilar": () => new Response("upstream exploded", { status: 500 }),
    });
    const rec = await engine.recommend({ type: "track", artist: "Radiohead", title: "Karma Police" });
    expect(rec.sources.lastfm).toBe("error");
    expect(rec.warnings.some((w) => w.startsWith("Last.fm:"))).toBe(true);
    expect(rec.relatedTracks.map((t) => t.title)).toEqual(expect.arrayContaining(["No Surprises", "Do I Wanna Know?"]));
  });

  it("works without Last.fm (keyless) and says how to improve results", async () => {
    const { engine } = engineWith({ ...lbRoutes, ...mbRoutes }, { lastfm: false });
    const rec = await engine.recommend({ type: "artist", artist: "Radiohead" });
    expect(rec.sources.lastfm).toBe("disabled");
    expect(rec.relatedTracks.length).toBeGreaterThan(0);
    expect(rec.warnings).toContain("Tip: set LASTFM_API_KEY for richer similar-track results.");
  });

  it("orders ListenBrainz similar artists by similarity score, not by MBID key order", async () => {
    const { engine } = engineWith(
      {
        ...mbRoutes,
        [`api.listenbrainz.org/1/lb-radio/artist/${RADIOHEAD}`]: () => ({
          "0000-alphabetically-first": [{ recording_mbid: "rec-q", similar_artist_name: "Queen", total_listen_count: 9_999 }],
          [ARCTIC]: [{ recording_mbid: "rec-dwk", similar_artist_name: "Arctic Monkeys", total_listen_count: 10 }],
        }),
        "labs.api.listenbrainz.org/similar-artists/json": () => [
          { artist_mbid: ARCTIC, name: "Arctic Monkeys", score: 900 },
          { artist_mbid: "0000-alphabetically-first", name: "Queen", score: 100 },
          { artist_mbid: "mbid-muse", name: "Muse", score: 50 },
        ],
        "api.listenbrainz.org/1/metadata/recording": lbRoutes["api.listenbrainz.org/1/metadata/recording"]!,
      },
      { lastfm: false },
    );
    const rec = await engine.recommend({ type: "artist", artist: "Radiohead" });
    expect(rec.similarArtists.map((a) => a.name)).toEqual(["Arctic Monkeys", "Queen", "Muse"]);
  });

  it("resolves a provider trackId seed to artist + title", async () => {
    const { engine } = engineWith({ ...lastfmRoutes }, { lb: false, mb: false });
    const rec = await engine.recommend({ type: "track", trackId: "demo:demo-12" });
    expect(rec.seed).toMatchObject({ artist: "Radiohead", title: "Karma Police" });
  });

  it("builds a radio queue of playable tracks only, honouring exclusions", async () => {
    const { engine } = engineWith({ ...lastfmRoutes, ...lbRoutes, ...mbRoutes });
    const first = await engine.radio({ type: "track", artist: "Radiohead", title: "Karma Police" }, { limit: 2 });
    expect(first.tracks).toHaveLength(2);
    expect(first.tracks.every((t) => t.id.startsWith("demo:"))).toBe(true);
    expect(first.exhausted).toBe(false);

    const exclude = first.tracks.flatMap((t) => [t.id, t.key]);
    const next = await engine.radio({ type: "track", artist: "Radiohead", title: "Karma Police" }, { exclude, limit: 10 });
    expect(next.tracks.some((t) => exclude.includes(t.id))).toBe(false);
    expect(next.exhausted).toBe(true);
    expect(next.tracks.find((t) => t.title === "Karma Police")).toBeUndefined();
  });

  it("fills a radio station with library tracks by recommended artists when exact matches run short", async () => {
    const { engine } = engineWith(
      {
        "tag.getTopTracks": () => ({ tracks: { track: [{ name: "Some Deep Cut", artist: { name: "AP Dhillon" } }] } }),
        "tag.getTopArtists": () => ({ topartists: { artist: [{ name: "AP Dhillon" }, { name: "Diljit Dosanjh" }] } }),
      },
      { lb: false, mb: false },
    );
    const res = await engine.radio({ type: "tag", tag: "punjabi pop" }, { limit: 5 });
    expect(res.tracks.map((t) => t.artist)).toEqual(expect.arrayContaining(["AP Dhillon", "Diljit Dosanjh"]));
    expect(res.tracks.every((t) => t.reason?.startsWith("More by "))).toBe(true);
    expect(res.tracks.filter((t) => t.artist === "AP Dhillon").length).toBeLessThanOrEqual(2);

    const again = await engine.radio({ type: "tag", tag: "punjabi pop" }, { limit: 5, exclude: res.tracks.map((t) => t.id) });
    expect(again.tracks.some((t) => res.tracks.some((r) => r.id === t.id))).toBe(false);
  });

  it("includes the seed artist's own library tracks in artist radio", async () => {
    const { engine } = engineWith({ ...lastfmRoutes }, { lb: false, mb: false });
    const res = await engine.radio({ type: "artist", artist: "Radiohead" }, { limit: 10 });
    expect(res.tracks.some((t) => t.artist === "Radiohead")).toBe(true);
  });

  it("caches the candidate pool so repeated seeds do not hammer the APIs", async () => {
    const { engine, seen } = engineWith({ ...lastfmRoutes }, { lb: false, mb: false });
    await engine.recommend({ type: "artist", artist: "Radiohead" });
    const calls = seen.length;
    await engine.recommend({ type: "artist", artist: "radiohead " });
    expect(seen.length).toBe(calls);
  });

  it("validates seeds", async () => {
    const { engine } = engineWith({});
    await expect(engine.recommend({ type: "track", artist: "x" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(engine.recommend({ type: "tag" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("helpers", () => {
  it("expandTag knows common aliases", () => {
    expect(expandTag("hip-hop")).toEqual(expect.arrayContaining(["hip hop", "rap"]));
    expect(expandTag("Indie")).toContain("indie rock");
    expect(expandTag("dark ambient")).toEqual(["dark ambient", "dark", "ambient"]);
  });

  it("primaryArtist keeps the first credited artist", () => {
    expect(primaryArtist("AP Dhillon, Gurinder Gill & Shinda Kahlon")).toBe("AP Dhillon");
    expect(primaryArtist("Gorillaz feat. Mos Def")).toBe("Gorillaz");
    expect(primaryArtist("Simon & Garfunkel")).toBe("Simon");
    expect(primaryArtist("Radiohead")).toBe("Radiohead");
  });

  it("diversify caps tracks per artist before letting extras through", () => {
    const items = [{ artist: "A" }, { artist: "A" }, { artist: "A" }, { artist: "B" }, { artist: "A feat. C" }];
    expect(diversify(items, 2).map((i) => i.artist)).toEqual(["A", "A", "B", "A", "A feat. C"]);
  });
});

describe("HTTP endpoints", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => app?.close());

  it("GET /api/recommendations and POST /api/radio", async () => {
    const config = demoConfig();
    const services = await createServices(config, { cache: new MemoryCache() });
    app = await buildApp({ config, services });
    const rec = await app.inject("/api/recommendations?type=tag&tag=indie");
    expect(rec.statusCode).toBe(200);
    expect(rec.json()).toMatchObject({ seed: { type: "tag", tag: "indie" }, warnings: ["No recommendation sources are enabled."] });

    expect((await app.inject("/api/recommendations?type=track&artist=x")).statusCode).toBe(400);
    expect((await app.inject("/api/recommendations?type=bogus")).statusCode).toBe(400);

    const radio = await app.inject({ method: "POST", url: "/api/radio", payload: { seed: { type: "artist", artist: "Radiohead" } } });
    expect(radio.statusCode).toBe(200);
    // No metadata sources enabled, but artist radio still plays the seed artist from the library.
    expect(radio.json().tracks.map((t: { artist: string }) => t.artist)).toEqual(["Radiohead", "Radiohead"]);
    expect(radio.json().exhausted).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/radio", payload: {} })).statusCode).toBe(400);
  });
});
