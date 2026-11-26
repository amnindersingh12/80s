import { describe, expect, it } from "vitest";
import { describeTopLevel, firstMatch, mask, maskEmail, runDoctor, scrubBody } from "../src/doctor.js";

const BASE_ENV = {
  MEDIA_API_BASE: "https://media.test",
  SUPABASE_URL: "https://proj.supabase.test",
  SUPABASE_ANON_KEY: "anon-key-1234567890",
  MEDIA_USER_EMAIL: "someone@example.com",
  MEDIA_USER_PASSWORD: "super-secret-password",
  LISTENBRAINZ_ENABLED: "false",
  MUSICBRAINZ_ENABLED: "false",
};

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(new URL(String(input)), init ?? {})) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function run(env: Record<string, string>, handler: Handler) {
  const lines: string[] = [];
  const result = await runDoctor({ env, fetch: fakeFetch(handler), log: (l) => lines.push(l), query: "test" });
  return { result, out: lines.join("\n") };
}

describe("doctor helpers", () => {
  it("masks secrets without revealing them", () => {
    expect(mask("abcdefghijkl")).toBe("abcd…(12 chars)");
    expect(mask("abc")).toBe("•••• (3 chars)");
    expect(maskEmail("someone@example.com")).toBe("so***@example.com");
  });

  it("scrubs tokens from echoed bodies", () => {
    const body = JSON.stringify({ access_token: "eyJabc", refresh_token: "rt", note: "pw=hunter22" });
    const out = scrubBody(body, ["hunter22"]);
    expect(out).not.toContain("eyJabc");
    expect(out).not.toContain("hunter22");
    expect(out).toContain('"access_token":"***"');
  });

  it("describes top-level JSON and finds the first matching path", () => {
    expect(describeTopLevel({ data: { items: [1] }, total: 3 })).toBe("{ data: {items}, total: number }");
    expect(describeTopLevel([1, 2])).toBe("array with 2 item(s)");
    expect(firstMatch({ data: { tracks: [1] } }, "results|data.tracks")).toEqual({ path: "data.tracks", value: [1] });
    expect(firstMatch({}, "a|b")).toBeUndefined();
  });
});

describe("runDoctor", () => {
  it("passes a healthy setup and prints the field mapping", async () => {
    const { result, out } = await run(BASE_ENV, (url, init) => {
      if (url.pathname === "/auth/v1/token") {
        expect((init.headers as Record<string, string>).apikey).toBe("anon-key-1234567890");
        return json({ access_token: "jwt-token-value", refresh_token: "rt-1", expires_in: 3600 });
      }
      if (url.pathname === "/api/search") {
        expect((init.headers as Record<string, string>).authorization).toBe("Bearer jwt-token-value");
        return json({ results: [{ id: "t1", title: "Song", artist: { name: "Band" }, format: "flac" }], total: 1 });
      }
      throw new Error(`unexpected ${url}`);
    });
    expect(result.ok).toBe(true);
    expect(out).toContain("Top-level JSON: { results: [1], total: number }");
    expect(out).toMatch(/✓ artist\s+← artist\.name/);
    expect(out).not.toContain("super-secret-password");
    expect(out).not.toContain("jwt-token-value");
    expect(out).toContain("so***@example.com");
  });

  it("reports the exact status and body when Supabase login fails", async () => {
    const { result, out } = await run(BASE_ENV, (url) => {
      if (url.pathname === "/auth/v1/token") return json({ error: "invalid_grant", error_description: "Invalid login credentials" }, 400);
      throw new Error(`unexpected ${url}`);
    });
    expect(result.ok).toBe(false);
    expect(out).toContain("Password grant → HTTP 400");
    expect(out).toContain("Invalid login credentials");
    expect(result.steps.find((s) => s.name === "search")?.status).toBe("skip");
  });

  it("flags unmapped required fields so MEDIA_FIELD_MAP can be fixed", async () => {
    const { result, out } = await run(BASE_ENV, (url) => {
      if (url.pathname === "/auth/v1/token") return json({ access_token: "jwt", refresh_token: "rt", expires_in: 3600 });
      return json({ payload: { songs: [{ uuid: "x", songTitle: "T", performer: "P" }] } });
    });
    expect(result.ok).toBe(false);
    expect(out).toContain("found no array");

    const fixed = await run(
      { ...BASE_ENV, MEDIA_SEARCH_RESULTS_PATH: "payload.songs" },
      (url) => {
        if (url.pathname === "/auth/v1/token") return json({ access_token: "jwt", refresh_token: "rt", expires_in: 3600 });
        return json({ payload: { songs: [{ uuid: "x", songTitle: "T", performer: "P" }] } });
      },
    );
    expect(fixed.out).toContain("First item keys: uuid, songTitle, performer");
    expect(fixed.out).toMatch(/✗ title\s+← \(none of:/);
    expect(fixed.result.ok).toBe(false);
  });

  it("fails fast on invalid config and skips network checks", async () => {
    const { result, out } = await run({ MEDIA_API_BASE: "https://media.test", LISTENBRAINZ_ENABLED: "false", MUSICBRAINZ_ENABLED: "false" }, () => {
      throw new Error("no network expected");
    });
    expect(result.ok).toBe(false);
    expect(out).toContain("SUPABASE_URL is required");
  });

  it("checks Last.fm keys", async () => {
    const { result, out } = await run({ LASTFM_API_KEY: "bad-key-123", LISTENBRAINZ_ENABLED: "false", MUSICBRAINZ_ENABLED: "false" }, (url) => {
      expect(url.searchParams.get("api_key")).toBe("bad-key-123");
      return json({ error: 10, message: "Invalid API key" }, 403);
    });
    expect(result.ok).toBe(false);
    expect(out).toContain("Last.fm: error 10: Invalid API key");
  });
});
