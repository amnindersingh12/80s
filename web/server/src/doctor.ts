/**
 * `npm run doctor` — step-by-step live check of the `.env` configuration.
 *
 *   1. Env vars: validates them with the real config parser and prints masked values.
 *   2. Supabase: password grant and/or refresh grant, with the exact HTTP status + body on failure.
 *   3. Media search: one sample search, the raw top-level JSON keys, and which `MEDIA_*` mapping
 *      matched (or didn't) on the first result.
 *   4. Recommendation sources: Last.fm, ListenBrainz and MusicBrainz reachability.
 *
 * Usage: `npm run doctor [-- "sample query"]`. Exit code 1 when any step fails.
 * Secrets are never printed in full, and tokens are scrubbed from echoed response bodies.
 */
import { pathToFileURL } from "node:url";
import { ConfigError, loadConfig, type Config, type Env, type TrackFieldMap } from "./config.js";
import { applyDiscovery, discoverFrontend, jwtPayload, needsDiscovery, type DiscoveryResult } from "./lib/discovery.js";
import { loadDotEnv } from "./lib/env.js";
import { getPath, pickArray } from "./lib/fields.js";

type Status = "ok" | "warn" | "fail" | "skip";

export interface DoctorOptions {
  env: Env;
  /** Startup discovery to reuse instead of scanning MEDIA_FRONTEND_URL again. */
  discovery?: DiscoveryResult;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  query?: string;
  timeoutMs?: number;
  envFile?: string;
}

export interface DoctorResult {
  ok: boolean;
  steps: { name: string; status: Status }[];
}

const SECRET_VARS = new Set([
  "APP_ACCESS_KEY",
  "SUPABASE_ANON_KEY",
  "MEDIA_USER_PASSWORD",
  "MEDIA_REFRESH_TOKEN",
  "MEDIA_BEARER_TOKEN",
  "SUBSONIC_API_KEY",
  "SUBSONIC_PASSWORD",
  "LASTFM_API_KEY",
  "LISTENBRAINZ_TOKEN",
  "REDIS_URL",
]);

/** Variables shown in step 1, in display order. */
const SHOWN_VARS = [
  "HOST", "PORT", "APP_ACCESS_KEY", "DEMO_MODE", "REDIS_URL",
  "MEDIA_FRONTEND_URL", "MEDIA_API_BASE", "MEDIA_AUTH_MODE", "MEDIA_BEARER_TOKEN", "MEDIA_SEARCH_PATH", "MEDIA_SEARCH_PARAM", "MEDIA_SEARCH_RESULTS_PATH", "MEDIA_FIELD_MAP",
  "MEDIA_JOB_CREATE_PATH", "MEDIA_JOB_CREATE_METHOD", "MEDIA_TRACK_ID_FIELD", "MEDIA_JOB_STATUS_PATH", "MEDIA_JOB_FIELD_MAP",
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "MEDIA_USER_EMAIL", "MEDIA_USER_PASSWORD", "MEDIA_REFRESH_TOKEN",
  "SUBSONIC_URL", "SUBSONIC_USER", "SUBSONIC_PASSWORD", "SUBSONIC_API_KEY",
  "LASTFM_API_KEY", "LISTENBRAINZ_ENABLED", "LISTENBRAINZ_TOKEN", "MUSICBRAINZ_ENABLED", "MUSICBRAINZ_USER_AGENT",
];

/** `abcd…(32 chars)` — enough to recognise a value without revealing it. */
export function mask(value: string): string {
  if (value.length <= 4) return `•••• (${value.length} chars)`;
  return `${value.slice(0, 4)}…(${value.length} chars)`;
}

export function maskEmail(value: string): string {
  const at = value.indexOf("@");
  if (at < 1) return mask(value);
  return `${value.slice(0, Math.min(2, at))}***${value.slice(at)}`;
}

/** Redis URLs may carry a password: keep scheme/host, hide credentials. */
function maskUrlCredentials(value: string): string {
  try {
    const u = new URL(value);
    if (u.password) u.password = "****";
    return u.toString();
  } catch {
    return mask(value);
  }
}

export function displayValue(name: string, value: string): string {
  if (name === "MEDIA_USER_EMAIL") return maskEmail(value);
  if (name === "REDIS_URL") return maskUrlCredentials(value);
  if (SECRET_VARS.has(name)) return mask(value);
  return value;
}

/** Removes token-like values from a response body before it is echoed. */
export function scrubBody(text: string, secrets: (string | undefined)[] = []): string {
  let out = text.replace(/("(?:access_token|refresh_token|provider_token|id_token|token|password|apiKey|api_key)"\s*:\s*")[^"]*"/gi, '$1***"');
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("***");
  return out.length > 800 ? `${out.slice(0, 800)}… (${out.length} bytes)` : out;
}

/** `{a, b: [3 items], c: {…}}` style summary of a JSON value's top level. */
export function describeTopLevel(data: unknown): string {
  if (Array.isArray(data)) return `array with ${data.length} item(s)`;
  if (data === null || typeof data !== "object") return `${data === null ? "null" : typeof data}`;
  const parts = Object.entries(data as Record<string, unknown>).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.length}]`;
    if (v && typeof v === "object") return `${k}: {${Object.keys(v).slice(0, 6).join(", ")}${Object.keys(v).length > 6 ? ", …" : ""}}`;
    return `${k}: ${typeof v}`;
  });
  return `{ ${parts.join(", ")} }`;
}

/** First `|` alternative of [spec] that resolves on [obj], with its value. */
export function firstMatch(obj: unknown, spec: string): { path: string; value: unknown } | undefined {
  for (const path of spec.split("|").map((p) => p.trim()).filter(Boolean)) {
    const v = getPath(obj, path);
    if (v !== undefined && v !== null && v !== "") return { path, value: v };
  }
  return undefined;
}

function preview(value: unknown): string {
  const s = typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value) ?? String(value);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

interface HttpResult {
  status: number;
  text: string;
  json: unknown;
  ms: number;
  error?: string;
}

class Doctor {
  private readonly fetchFn: typeof fetch;
  private readonly log: (line: string) => void;
  private readonly timeoutMs: number;
  readonly steps: { name: string; status: Status }[] = [];

  constructor(private readonly opts: DoctorOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.log = opts.log ?? ((line) => console.log(line));
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private heading(n: number, title: string) {
    this.log("");
    this.log(`── ${n}. ${title} ${"─".repeat(Math.max(0, 60 - title.length))}`);
  }

  private line(status: Status, text: string) {
    const icon = { ok: "✓", warn: "!", fail: "✗", skip: "-" }[status];
    this.log(`  ${icon} ${text}`);
  }

  private detail(text: string) {
    this.log(`      ${text}`);
  }

  private record(name: string, status: Status) {
    this.steps.push({ name, status });
  }

  private async http(url: string, init: RequestInit = {}): Promise<HttpResult> {
    const started = Date.now();
    try {
      const res = await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      return { status: res.status, text, json, ms: Date.now() - started };
    } catch (err) {
      const e = err as Error;
      const reason = e.name === "TimeoutError" ? `timed out after ${this.timeoutMs} ms` : `${e.name}: ${e.message}${causeOf(e)}`;
      return { status: 0, text: "", json: undefined, ms: Date.now() - started, error: reason };
    }
  }

  async run(): Promise<DoctorResult> {
    const rawEnv = this.opts.env;
    this.log("80s web — configuration doctor");
    this.log(this.opts.envFile ? `Loaded ${this.opts.envFile}` : "No .env file found — using process environment only");

    // ---------------------------------------------------- 1. frontend discovery
    this.heading(1, "MEDIA_FRONTEND_URL discovery");
    const env = await this.checkDiscovery(rawEnv);

    // ---------------------------------------------------------------- 2. env
    this.heading(2, "Environment");
    for (const name of SHOWN_VARS) {
      const v = env[name];
      if (v === undefined || v.trim() === "") continue;
      const discovered = !rawEnv[name]?.trim() ? "  (discovered)" : "";
      this.detail(`${name.padEnd(28)} ${displayValue(name, v.trim())}${discovered}`);
    }
    let config: Config | undefined;
    try {
      config = loadConfig(env);
      this.line("ok", "Config parses (same validation as the server)");
      this.record("env", "ok");
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      this.line("fail", "Config is invalid — the server would refuse to start:");
      for (const problem of err.problems) this.detail(`- ${problem}`);
      this.record("env", "fail");
    }
    if (config) {
      if (config.demo) this.line("warn", "DEMO MODE: no MEDIA_API_BASE / SUBSONIC_URL — the server serves synthetic clips");
      else if (config.remote) {
        const setting = config.remote.authModeSetting === "auto" ? `auto → ${config.remote.authMode}` : config.remote.authMode;
        this.line("ok", `Live mode against ${config.remote.baseUrl} (MEDIA_AUTH_MODE=${setting})`);
      }
      if (!config.accessKey) this.line("warn", "APP_ACCESS_KEY is empty — anyone who can reach the server can use it");
      if (config.host === "127.0.0.1" || config.host === "localhost") {
        this.line("warn", `HOST=${config.host}: only reachable from this machine (use 0.0.0.0 for LAN / Docker / phones)`);
      }
    }

    // --------------------------------------------------------- 3. media auth
    this.heading(3, "Media server auth");
    let accessToken: string | undefined;
    let authUsable = false;
    const remote = config?.remote;
    if (!remote) {
      this.line("skip", "MEDIA_API_BASE not set (or config invalid) — skipped");
      this.record("auth", "skip");
    } else if (remote.authMode === "none") {
      this.line("ok", "MEDIA_AUTH_MODE=none — requests go out without credentials (guest / public API)");
      if (env.SUPABASE_URL?.trim()) this.line("warn", "SUPABASE_URL is set but ignored because MEDIA_AUTH_MODE=none");
      this.record("auth", "ok");
      authUsable = true;
    } else if (remote.authMode === "bearer") {
      accessToken = remote.bearerToken;
      this.line("ok", `MEDIA_AUTH_MODE=bearer — static MEDIA_BEARER_TOKEN ${mask(accessToken ?? "")} (validated by the search below)`);
      this.record("auth", "ok");
      authUsable = true;
    } else {
      this.detail("MEDIA_AUTH_MODE=supabase");
      accessToken = await this.checkSupabase(remote.supabase);
      authUsable = accessToken !== undefined;
    }

    // ------------------------------------------------------------- 4. search
    this.heading(4, "Sample media search");
    if (!remote) {
      this.line("skip", "MEDIA_API_BASE not set — skipped");
      this.record("search", "skip");
    } else if (!authUsable) {
      this.line("skip", "No access token from step 2 — skipped");
      this.record("search", "skip");
    } else {
      await this.checkSearch(remote, accessToken);
    }

    // ------------------------------------------------------ 5. recommendations
    this.heading(5, "Recommendation sources");
    await this.checkRecommendations(config, env);

    const failed = this.steps.filter((s) => s.status === "fail");
    this.log("");
    this.log(failed.length ? `✗ ${failed.length} check(s) failed: ${failed.map((s) => s.name).join(", ")}` : "✓ All checks passed");
    return { ok: failed.length === 0, steps: this.steps };
  }

  /** Runs (or reuses) MEDIA_FRONTEND_URL discovery and returns the env the server would use. */
  private async checkDiscovery(rawEnv: Env): Promise<Env> {
    const frontend = rawEnv.MEDIA_FRONTEND_URL?.trim();
    if (!frontend) {
      this.line("skip", "MEDIA_FRONTEND_URL not set — using explicit SUPABASE_* / MEDIA_API_BASE only");
      this.record("discovery", "skip");
      return rawEnv;
    }
    if (!needsDiscovery(rawEnv)) {
      this.line("skip", "SUPABASE_URL, SUPABASE_ANON_KEY and MEDIA_API_BASE are all set explicitly — nothing to discover");
      this.record("discovery", "skip");
      return rawEnv;
    }
    const reused = this.opts.discovery?.frontendUrl === frontend;
    const found = reused ? this.opts.discovery! : await discoverFrontend(frontend, { fetch: this.fetchFn, timeoutMs: this.timeoutMs, deadlineMs: 12_000 });
    this.detail(`${reused ? "Cached at startup" : "Scanned"}: ${found.scanned.length} file(s) in ${found.durationMs} ms from ${frontend}`);
    const { env, filled } = applyDiscovery(rawEnv, found);
    const report = (key: string, label: string, value: string | undefined, shown: string | undefined) => {
      if (rawEnv[key]?.trim()) this.detail(`${label.padEnd(18)} explicit ${key} (overrides discovery)`);
      else if (value) this.line("ok", `${label.padEnd(18)} ${shown}`);
      else this.line("warn", `${label.padEnd(18)} not found in the frontend code — set ${key}`);
    };
    report("SUPABASE_URL", "Supabase URL", found.supabaseUrl, found.supabaseUrl);
    report("SUPABASE_ANON_KEY", "Anon key", found.anonKey, found.anonKey && `${mask(found.anonKey)}${found.anonKey.startsWith("eyJ") ? ` (role=${jwtPayload(found.anonKey)?.role})` : ""}`);
    report(
      "MEDIA_API_BASE",
      "API base",
      found.apiBase,
      found.apiBase && `${found.apiBase}${found.apiBaseSource === "frontend-origin" ? "  (guess: frontend origin — no API URL found in code)" : ""}`,
    );
    for (const e of found.errors.slice(0, 5)) this.detail(`  ${e}`);
    const status: Status = found.scanned.length === 0 ? "fail" : filled.length ? "ok" : "warn";
    if (status === "fail") this.line("fail", `Couldn't load ${frontend}`);
    this.record("discovery", status);
    return env;
  }

  private async checkSupabase(sb: NonNullable<Config["remote"]>["supabase"]): Promise<string | undefined> {
    const base = `${sb.url.replace(/\/+$/, "")}/auth/v1/token`;
    const secrets = [sb.password, sb.refreshToken, sb.anonKey];
    const grant = async (type: "password" | "refresh_token", body: Record<string, unknown>) => {
      const res = await this.http(`${base}?grant_type=${type}`, {
        method: "POST",
        headers: { apikey: sb.anonKey, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (res.json ?? {}) as { access_token?: string; refresh_token?: string; expires_in?: number };
      return { res, data, ok: res.status >= 200 && res.status < 300 && Boolean(data.access_token) };
    };

    let accessToken: string | undefined;
    let refreshToken = sb.refreshToken;
    let failed = false;

    if (sb.email && sb.password) {
      const { res, data, ok } = await grant("password", { email: sb.email, password: sb.password });
      if (ok) {
        this.line("ok", `Password grant → HTTP ${res.status} in ${res.ms} ms (token expires in ${data.expires_in ?? "?"} s)`);
        accessToken = data.access_token;
        refreshToken = data.refresh_token ?? refreshToken;
      } else {
        failed = true;
        this.reportFailure("Password grant", res, secrets);
        if (res.status === 400) this.detail("Hint: 400 invalid_grant = wrong MEDIA_USER_EMAIL / MEDIA_USER_PASSWORD (or email not confirmed)");
        if (res.status === 401) this.detail("Hint: 401 = SUPABASE_ANON_KEY doesn't belong to SUPABASE_URL's project");
        if (res.status === 404) this.detail("Hint: 404 = SUPABASE_URL should be the project root, e.g. https://abcd.supabase.co");
      }
    } else {
      this.line("skip", "No MEDIA_USER_EMAIL + MEDIA_USER_PASSWORD — password grant skipped");
    }

    if (refreshToken) {
      const seeded = refreshToken === sb.refreshToken && !accessToken;
      const { res, data, ok } = await grant("refresh_token", { refresh_token: refreshToken });
      if (ok) {
        this.line("ok", `Refresh grant (${seeded ? "MEDIA_REFRESH_TOKEN" : "token from password grant"}) → HTTP ${res.status} in ${res.ms} ms`);
        accessToken = data.access_token ?? accessToken;
        if (seeded && data.refresh_token && data.refresh_token !== refreshToken) {
          this.detail("Note: Supabase rotated the refresh token. The server keeps the new one in memory; with only");
          this.detail("MEDIA_REFRESH_TOKEN set (no password) a restart reuses the old one, which may now be revoked.");
        }
      } else {
        // A refresh failure after a successful password grant is fatal for long-running servers.
        failed = true;
        this.reportFailure(`Refresh grant (${seeded ? "MEDIA_REFRESH_TOKEN" : "token from password grant"})`, res, secrets);
        if (seeded) this.detail("Hint: the seeded refresh token is expired, revoked or already used — set a fresh one or a password");
      }
    } else if (accessToken) {
      this.line("warn", "Password grant returned no refresh_token — the server will re-login on every expiry");
    }

    this.record("auth", failed ? "fail" : accessToken ? "ok" : "fail");
    return accessToken;
  }

  private reportFailure(label: string, res: HttpResult, secrets: (string | undefined)[]) {
    if (res.error) {
      this.line("fail", `${label} → no response (${res.error})`);
    } else {
      this.line("fail", `${label} → HTTP ${res.status} in ${res.ms} ms`);
      this.detail(`Body: ${scrubBody(res.text || "(empty)", secrets)}`);
    }
  }

  private async checkSearch(remote: NonNullable<Config["remote"]>, token: string | undefined) {
    const query = this.opts.query?.trim() || "love";
    const url = new URL(remote.baseUrl.replace(/\/+$/, "") + remote.searchPath);
    for (const [k, v] of Object.entries(remote.searchExtraParams)) url.searchParams.set(k, v);
    url.searchParams.set(remote.searchParam, query);
    if (remote.searchLimitParam) url.searchParams.set(remote.searchLimitParam, "5");

    const headers: Record<string, string> = { accept: "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await this.http(url.toString(), { headers });
    if (res.error || res.status < 200 || res.status >= 300) {
      this.reportFailure(`GET ${url.pathname}?${remote.searchParam}=${query}`, res, [token]);
      if (res.status === 401 || res.status === 403) {
        this.detail(
          remote.authMode === "none"
            ? "Hint: this endpoint needs credentials — set MEDIA_AUTH_MODE=bearer + MEDIA_BEARER_TOKEN (or supabase)"
            : remote.authMode === "bearer"
              ? "Hint: the media server rejected MEDIA_BEARER_TOKEN (expired or wrong token?)"
              : "Hint: the media server rejected the Supabase JWT — is it the same Supabase project?",
        );
      }
      if (res.status === 404) this.detail("Hint: 404 = check MEDIA_API_BASE + MEDIA_SEARCH_PATH");
      this.record("search", "fail");
      return;
    }
    this.line("ok", `GET ${url.pathname}?${remote.searchParam}=${encodeURIComponent(query)} → HTTP ${res.status} in ${res.ms} ms`);
    if (res.json === undefined) {
      this.line("fail", "Response is not JSON");
      this.detail(`Body: ${scrubBody(res.text, [token])}`);
      this.record("search", "fail");
      return;
    }
    this.detail(`Top-level JSON: ${describeTopLevel(res.json)}`);

    const resultsMatch = Array.isArray(res.json) ? { path: "(root array)", value: res.json } : firstMatch(res.json, remote.searchResultsPath);
    const items = pickArray(res.json, remote.searchResultsPath);
    if (!resultsMatch || !Array.isArray(resultsMatch.value)) {
      this.line("fail", `MEDIA_SEARCH_RESULTS_PATH="${remote.searchResultsPath}" found no array in the response`);
      this.detail("Fix: set MEDIA_SEARCH_RESULTS_PATH to the key holding the track list (dot paths allowed, e.g. data.tracks)");
      this.record("search", "fail");
      return;
    }
    this.line("ok", `Results array at "${resultsMatch.path}" (${items.length} item(s)) via MEDIA_SEARCH_RESULTS_PATH`);
    const first = items[0];
    if (first === undefined) {
      this.line("warn", `No results for "${query}" — run again with another query: npm run doctor -- "artist name"`);
      this.record("search", "warn");
      return;
    }
    this.detail(`First item keys: ${first && typeof first === "object" ? Object.keys(first).join(", ") : typeof first}`);
    this.detail("");
    this.detail("Track field mapping (MEDIA_FIELD_MAP overrides these defaults):");

    const required: (keyof TrackFieldMap)[] = ["id", "title", "artist"];
    let missingRequired = 0;
    for (const [field, spec] of Object.entries(remote.trackFields) as [keyof TrackFieldMap, string][]) {
      const m = firstMatch(first, spec);
      const isRequired = required.includes(field);
      if (m) {
        this.detail(`  ✓ ${field.padEnd(12)} ← ${m.path.padEnd(18)} ${preview(m.value)}`);
      } else {
        if (isRequired) missingRequired++;
        this.detail(`  ${isRequired ? "✗" : "-"} ${field.padEnd(12)} ← (none of: ${spec})`);
      }
    }
    if (missingRequired) {
      this.line("fail", `${missingRequired} required field(s) unmapped — tracks will be dropped from search results`);
      this.detail(`Fix: MEDIA_FIELD_MAP='{"id":"<key>","title":"<key>","artist":"<key>"}' using the keys listed above`);
      this.record("search", "fail");
      return;
    }
    const losslessHint = firstMatch(first, remote.trackFields.format) ?? firstMatch(first, remote.trackFields.quality);
    if (!losslessHint) this.line("warn", "No format/quality field matched — lossless badges will be missing");
    this.record("search", "ok");
  }

  private async checkRecommendations(config: Config | undefined, env: Env) {
    const rec = config?.recommendations;
    let failures = 0;
    let checked = 0;

    const lastfmKey = env.LASTFM_API_KEY?.trim();
    const lbEnabled = !(rec && !rec.listenbrainz);
    const mbEnabled = !(rec && !rec.musicbrainz);
    const lbToken = rec?.listenbrainz?.token;
    const mbUserAgent = rec?.musicbrainz?.userAgent ?? "80sWebPlayer/0.1 ( self-hosted; set MUSICBRAINZ_USER_AGENT )";

    // The three sources are independent: query them in parallel, report in a fixed order.
    const lastfmReq = (() => {
      if (!lastfmKey) return undefined;
      const base = rec?.lastfm?.baseUrl ?? env.LASTFM_API_BASE ?? "https://ws.audioscrobbler.com/2.0";
      const u = new URL(base.replace(/\/+$/, "") + "/");
      u.searchParams.set("method", "artist.getsimilar");
      u.searchParams.set("artist", "Radiohead");
      u.searchParams.set("limit", "1");
      u.searchParams.set("format", "json");
      u.searchParams.set("api_key", lastfmKey);
      return this.http(u.toString());
    })();
    const lbBase = (rec?.listenbrainz?.baseUrl ?? "https://api.listenbrainz.org").replace(/\/+$/, "");
    const lbReq = !lbEnabled
      ? undefined
      : lbToken
        ? this.http(`${lbBase}/1/validate-token`, { headers: { authorization: `Token ${lbToken}` } })
        : this.http(`${lbBase}/1/stats/sitewide/artists?count=1`);
    const mbBase = (rec?.musicbrainz?.baseUrl ?? "https://musicbrainz.org/ws/2").replace(/\/+$/, "");
    const mbReq = !mbEnabled
      ? undefined
      : this.http(`${mbBase}/artist?query=artist:radiohead&limit=1&fmt=json`, {
          headers: { "user-agent": mbUserAgent, accept: "application/json" },
        });
    const [lastfm, lb, mb] = await Promise.all([lastfmReq, lbReq, mbReq]);

    // Last.fm
    if (!lastfm) {
      this.line("warn", "Last.fm: LASTFM_API_KEY not set — recommendations use ListenBrainz/MusicBrainz only");
    } else {
      checked++;
      const body = lastfm.json as { error?: number; message?: string } | undefined;
      if (lastfm.status === 200 && !body?.error) {
        this.line("ok", `Last.fm: key accepted (HTTP 200 in ${lastfm.ms} ms)`);
      } else {
        failures++;
        const reason = lastfm.error ?? (body?.error ? `error ${body.error}: ${body.message}` : `HTTP ${lastfm.status}`);
        this.line("fail", `Last.fm: ${reason}`);
        if (body?.error === 10) this.detail("Hint: error 10 = invalid API key");
      }
    }

    // ListenBrainz
    if (!lb) {
      this.line("skip", "ListenBrainz: disabled (LISTENBRAINZ_ENABLED=false)");
    } else {
      checked++;
      const valid = lbToken ? (lb.json as { valid?: boolean } | undefined)?.valid === true : true;
      if (lb.status >= 200 && lb.status < 300 && valid) {
        this.line("ok", `ListenBrainz: reachable${lbToken ? ", token valid" : ""} (HTTP ${lb.status} in ${lb.ms} ms)`);
      } else if (lb.status >= 200 && lb.status < 300) {
        failures++;
        this.line("fail", "ListenBrainz: reachable but LISTENBRAINZ_TOKEN is invalid");
      } else {
        failures++;
        this.line("fail", `ListenBrainz: ${lb.error ?? `HTTP ${lb.status}`}`);
      }
    }

    // MusicBrainz
    if (!mb) {
      this.line("skip", "MusicBrainz: disabled (MUSICBRAINZ_ENABLED=false)");
    } else {
      checked++;
      if (mb.status === 200) {
        this.line("ok", `MusicBrainz: reachable (HTTP 200 in ${mb.ms} ms)`);
      } else {
        failures++;
        this.line("fail", `MusicBrainz: ${mb.error ?? `HTTP ${mb.status}`}`);
        if (mb.status === 403 || mb.status === 503) this.detail("Hint: MusicBrainz throttles generic User-Agents — set MUSICBRAINZ_USER_AGENT with a contact");
      }
      if (!env.MUSICBRAINZ_USER_AGENT?.trim()) {
        this.line("warn", 'MUSICBRAINZ_USER_AGENT not set — use "AppName/1.0 ( you@example.com )" in production');
      }
    }

    this.record("recommendations", failures ? "fail" : checked ? "ok" : "skip");
  }
}

function causeOf(e: Error): string {
  const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause;
  if (!cause) return "";
  return ` (${cause.code ?? cause.message ?? String(cause)})`;
}

export function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  return new Doctor(opts).run();
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const envFile = loadDotEnv();
  runDoctor({ env: process.env, query: process.argv.slice(2).join(" "), envFile })
    .then((r) => process.exit(r.ok ? 0 : 1))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
