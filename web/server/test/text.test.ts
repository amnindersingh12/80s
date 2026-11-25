import { describe, expect, it } from "vitest";
import { pick, pickArray, pickNumber, pickString } from "../src/lib/fields.js";
import { fillPath, joinUrl } from "../src/lib/http.js";
import { artistSimilarity, asciiFilename, bestMatch, contentDisposition, normalizeText, safeFilename, scoreMatch, trackKey } from "../src/lib/text.js";

describe("text normalisation & matching", () => {
  it("strips feat./remaster noise and Latin diacritics but keeps other scripts", () => {
    expect(normalizeText("Beyoncé – Halo (Remastered 2011)")).toBe("beyonce halo");
    expect(normalizeText("Excuses (feat. Gurinder Gill)")).toBe("excuses");
    expect(normalizeText("Song - Radio Edit")).toBe("song");
    expect(normalizeText("ਪਿਆਰ")).toBe("ਪਿਆਰ");
    expect(normalizeText("Simon & Garfunkel")).toBe("simon and garfunkel");
  });

  it("matches the same recording across naming differences", () => {
    const s = scoreMatch(
      { title: "Karma Police", artist: "Radiohead", durationSec: 264 },
      { title: "Karma Police - Remastered", artist: "Radiohead", durationSec: 263 },
    );
    expect(s.accepted).toBe(true);
    expect(scoreMatch({ title: "Excuses", artist: "AP Dhillon" }, { title: "Excuses", artist: "AP Dhillon, Gurinder Gill & Intense" }).accepted).toBe(true);
  });

  it("rejects different songs by the same artist and same titles by other artists", () => {
    expect(scoreMatch({ title: "Karma Police", artist: "Radiohead" }, { title: "No Surprises", artist: "Radiohead" }).accepted).toBe(false);
    expect(scoreMatch({ title: "Lover", artist: "Diljit Dosanjh" }, { title: "Lover", artist: "Taylor Swift" }).accepted).toBe(false);
  });

  it("prefers the closest duration and lossless copies", () => {
    const best = bestMatch({ title: "Lover", artist: "Diljit Dosanjh", durationSec: 182 }, [
      { title: "Lover", artist: "Diljit Dosanjh", durationSec: 260, lossless: true },
      { title: "Lover", artist: "Diljit Dosanjh", durationSec: 182, lossless: true },
    ]);
    expect(best?.candidate.durationSec).toBe(182);
  });

  it("builds stable dedupe keys", () => {
    expect(trackKey("AP Dhillon feat. Gurinder Gill", "Excuses (Official Video)")).toBe(trackKey("AP Dhillon", "Excuses"));
    expect(artistSimilarity("Sidhu Moose Wala", "Sidhu Moosewala")).toBeGreaterThan(0.8);
  });
});

describe("filenames", () => {
  it("removes characters that break filesystems", () => {
    expect(safeFilename('AC/DC - Back In Black: "Live"?', "flac")).toBe("AC DC - Back In Black Live.flac");
    expect(safeFilename("...", "flac")).toBe("track.flac");
    expect(safeFilename("a".repeat(400), "flac").length).toBe(185);
  });

  it("emits an ASCII fallback plus an RFC 5987 UTF-8 filename", () => {
    expect(asciiFilename("Beyoncé - Halo.flac")).toBe("Beyonce - Halo.flac");
    expect(contentDisposition("Diljit Dosanjh - Lover.flac")).toBe(
      `attachment; filename="Diljit Dosanjh - Lover.flac"; filename*=UTF-8''Diljit%20Dosanjh%20-%20Lover.flac`,
    );
    expect(contentDisposition("x'(y).flac")).toContain("filename*=UTF-8''x%27%28y%29.flac");
  });
});

describe("field mapping helpers", () => {
  const obj = { data: { items: [{ a: { b: "deep" }, artists: [{ name: "X" }, { name: "Y" }], n: "42" }] } };
  it("resolves dotted paths with | fallbacks", () => {
    expect(pick(obj, "missing|data.items.0.a.b")).toBe("deep");
    expect(pickString(obj, "data.items.0.artists")).toBe("X, Y");
    expect(pickNumber(obj, "data.items.0.n")).toBe(42);
    expect(pickArray(obj, "nope|data.items")).toHaveLength(1);
    expect(pickArray([1, 2], "results")).toEqual([1, 2]);
  });

  it("joins URLs and fills path templates safely", () => {
    expect(joinUrl("https://x.io/", "/api/a")).toBe("https://x.io/api/a");
    expect(joinUrl("https://x.io", "https://cdn.io/f")).toBe("https://cdn.io/f");
    expect(fillPath("/api/jobs/:jobId", { jobId: "a/b c" })).toBe("/api/jobs/a%2Fb%20c");
    expect(fillPath("/api/:missing", {})).toBe("/api/:missing");
  });
});
