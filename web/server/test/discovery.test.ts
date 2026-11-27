import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runDoctor } from "../src/doctor.js";
import { applyDiscovery, discoverFrontend, needsDiscovery } from "../src/lib/discovery.js";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;
const REF = "abcdefghijklmnopqrst";
const ANON = jwt({ iss: "supabase", ref: REF, role: "anon", exp: 2_000_000_000 });
const SERVICE = jwt({ iss: "supabase", ref: REF, role: "service_role" });

/** A tiny Next.js-looking site: config lives two chunks deep, plus decoys. */
function site(files: Record<string, string>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    const body = files[url.origin + url.pathname];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { status: 200, headers: { "content-type": url.pathname.endsWith(".js") ? "application/javascript" : "text/html" } });
  }) as typeof fetch;
}

const FRONT = "https://music.example.net";
const FILES: Record<string, string> = {
  [`${FRONT}/`]: `<!doctype html><html><head>
    <link rel="preload" as="script" href="/_next/static/chunks/webpack-1.js"/>
    <script src="/_next/static/chunks/main-app-2.js" async></script>
    <script src="https://cdn.thirdparty.com/analytics.js"></script>
    </head><body><a href="https://github.com/x">gh</a></body></html>`,
  [`${FRONT}/_next/static/chunks/webpack-1.js`]: `(()=>{var e="https://fonts.googleapis.com/css";})()`,
  [`${FRONT}/_next/static/chunks/main-app-2.js`]: `self.__next_f=[];import("/_next/static/chunks/app/layout-3.js");`,
  [`${FRONT}/_next/static/chunks/app/layout-3.js`]: `let s="${SERVICE}";const c={NEXT_PUBLIC_SUPABASE_URL:"https://${REF}.supabase.co",NEXT_PUBLIC_SUPABASE_ANON_KEY:"${ANON}",NEXT_PUBLIC_API_URL:"https://api.music.example.net/api"};fetch("https://o123.ingest.sentry.io/x")`,
};

describe("discoverFrontend", () => {
  it("finds the Supabase URL, anon key and API base across chained chunks, same-origin only", async () => {
    const calls: string[] = [];
    const found = await discoverFrontend(`${FRONT}/`, { fetch: site(FILES, calls) });
    expect(found.supabaseUrl).toBe(`https://${REF}.supabase.co`);
    expect(found.anonKey).toBe(ANON); // not the service_role key
    expect(found.apiBase).toBe("https://api.music.example.net"); // trailing /api stripped
    expect(found.apiBaseSource).toBe("code");
    expect(calls.some((c) => c.includes("thirdparty"))).toBe(false);
    expect(found.scanned).toContain(`${FRONT}/_next/static/chunks/app/layout-3.js`);
  });

  it("falls back to the frontend origin as API base and reports errors", async () => {
    const found = await discoverFrontend(`${FRONT}/`, {
      fetch: site({ [`${FRONT}/`]: `<script src="/_next/static/chunks/missing.js"></script>https://${REF}.supabase.co` }),
    });
    expect(found.supabaseUrl).toBe(`https://${REF}.supabase.co`);
    expect(found.anonKey).toBeUndefined();
    expect(found.apiBase).toBe(FRONT);
    expect(found.apiBaseSource).toBe("frontend-origin");
    expect(found.errors.join()).toContain("HTTP 404");
  });

  it("skips files over the size cap and stops at the chunk limit", async () => {
    const big = "x".repeat(2_000);
    const files: Record<string, string> = { [`${FRONT}/`]: Array.from({ length: 10 }, (_, i) => `<script src="/_next/static/c${i}.js"></script>`).join("") };
    for (let i = 0; i < 10; i++) files[`${FRONT}/_next/static/c${i}.js`] = i === 0 ? big : "";
    const calls: string[] = [];
    const found = await discoverFrontend(`${FRONT}/`, { fetch: site(files, calls), maxBytesPerFile: 1_000, maxChunks: 4 });
    expect(calls).toHaveLength(1 + 4);
    expect(found.errors.join()).toContain("too large");
  });

  it("supports new sb_publishable_ keys", async () => {
    const found = await discoverFrontend(`${FRONT}/`, {
      fetch: site({ [`${FRONT}/`]: `<script>window.cfg={url:"https://${REF}.supabase.co",key:"sb_publishable_AbCdEf0123456789xyz"}</script>` }),
    });
    expect(found.anonKey).toBe("sb_publishable_AbCdEf0123456789xyz");
  });
});

describe("applyDiscovery + MEDIA_AUTH_MODE=auto", () => {
  const found = { frontendUrl: FRONT, supabaseUrl: `https://${REF}.supabase.co`, anonKey: ANON, apiBase: "https://api.music.example.net", apiBaseSource: "code" as const, scanned: [FRONT], errors: [], durationMs: 1 };

  it("only fills blanks; explicit env always wins", () => {
    expect(needsDiscovery({ MEDIA_FRONTEND_URL: FRONT })).toBe(true);
    expect(needsDiscovery({ MEDIA_FRONTEND_URL: FRONT, SUPABASE_URL: "a", SUPABASE_ANON_KEY: "b", MEDIA_API_BASE: "c" })).toBe(false);
    expect(needsDiscovery({ SUPABASE_URL: "" })).toBe(false);
    const { env, filled } = applyDiscovery({ MEDIA_FRONTEND_URL: FRONT, MEDIA_API_BASE: "https://explicit.test" }, found);
    expect(env.MEDIA_API_BASE).toBe("https://explicit.test");
    expect(env.SUPABASE_URL).toBe(found.supabaseUrl);
    expect(filled).toEqual(["SUPABASE_URL", "SUPABASE_ANON_KEY"]);
  });

  it("auto logs in with Supabase when credentials exist (6 h TTL), otherwise guest none (20 min TTL)", () => {
    const login = loadConfig(applyDiscovery({ MEDIA_FRONTEND_URL: FRONT, MEDIA_USER_EMAIL: "me@x.test", MEDIA_USER_PASSWORD: "pw" }, found).env);
    expect(login.remote).toMatchObject({ authMode: "supabase", authModeSetting: "auto", baseUrl: "https://api.music.example.net" });
    expect(login.remote?.supabase).toMatchObject({ url: found.supabaseUrl, anonKey: ANON });
    expect(login.cacheTtl.streamUrlMs).toBe(21_600_000);
    expect(login.demo).toBe(false);

    const guest = loadConfig(applyDiscovery({ MEDIA_FRONTEND_URL: FRONT }, found).env);
    expect(guest.remote).toMatchObject({ authMode: "none", authModeSetting: "auto" });
    expect(guest.cacheTtl.streamUrlMs).toBe(1_200_000);

    // SUPABASE_URL alone (no login) is still guest mode.
    expect(loadConfig({ MEDIA_API_BASE: "https://m.test", SUPABASE_URL: "https://p.supabase.co" }).remote?.authMode).toBe("none");
  });

  it("explains how to fix a login without Supabase config", () => {
    expect(() => loadConfig({ MEDIA_API_BASE: "https://m.test", MEDIA_USER_EMAIL: "a@b.c", MEDIA_USER_PASSWORD: "pw" })).toThrow(/set MEDIA_FRONTEND_URL to discover it/);
  });
});

describe("doctor with MEDIA_FRONTEND_URL", () => {
  it("shows discovered values (masked) and marks them in the environment", async () => {
    const lines: string[] = [];
    const fetchFn = site({
      ...FILES,
      // the discovered API base answers the sample search as a guest
      "https://api.music.example.net/api/search": JSON.stringify({ results: [{ id: "1", title: "Song", artist: "Band", format: "flac" }] }),
    });
    const result = await runDoctor({
      env: { MEDIA_FRONTEND_URL: `${FRONT}/`, LISTENBRAINZ_ENABLED: "false", MUSICBRAINZ_ENABLED: "false" },
      fetch: fetchFn,
      log: (l) => lines.push(l),
    });
    const out = lines.join("\n");
    expect(result.steps.map((s) => s.name)).toEqual(["discovery", "env", "auth", "search", "recommendations"]);
    expect(out).toContain(`Supabase URL       https://${REF}.supabase.co`);
    expect(out).toContain("(role=anon)");
    expect(out).not.toContain(ANON);
    expect(out).toMatch(/MEDIA_API_BASE\s+https:\/\/api\.music\.example\.net\s+\(discovered\)/);
    expect(out).toContain("MEDIA_AUTH_MODE=auto → none");
    expect(result.ok).toBe(true);
  });
});
