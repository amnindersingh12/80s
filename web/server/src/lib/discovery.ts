/**
 * `MEDIA_FRONTEND_URL` auto-discovery.
 *
 * Next.js (and most SPA) frontends inline their *public* client config into the page and its
 * static JS chunks: the Supabase project URL, the anon key (a JWT with `"role":"anon"`, or a
 * `sb_publishable_…` key) and the API base URL. Those are the same values every visitor's
 * browser downloads, so instead of digging through DevTools we fetch the page once, scan it and
 * its same-origin chunks, and use what we find for any of SUPABASE_URL / SUPABASE_ANON_KEY /
 * MEDIA_API_BASE that were left blank. Explicit env vars always win.
 *
 * Everything stays in memory (Heroku's filesystem is ephemeral); size, count, time and
 * origin limits keep the scan cheap on a 512 MiB dyno.
 */
import type { Env } from "../config.js";

export interface DiscoveryResult {
  frontendUrl: string;
  supabaseUrl?: string;
  anonKey?: string;
  apiBase?: string;
  /** How the API base was chosen: a URL found in the code, or the frontend's own origin. */
  apiBaseSource?: "code" | "frontend-origin";
  /** URLs that were fetched and scanned (page + chunks). */
  scanned: string[];
  errors: string[];
  durationMs: number;
}

export interface DiscoveryOptions {
  fetch?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Overall budget (must stay well under Heroku's 60 s boot timeout). */
  deadlineMs?: number;
  maxChunks?: number;
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
}

const SUPABASE_URL_RE = /https:\/\/[a-z0-9-]{8,40}\.supabase\.(?:co|in)\b/gi;
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
const PUBLISHABLE_RE = /\bsb_publishable_[A-Za-z0-9_-]{16,}/g;
const SCRIPT_SRC_RE = /<script\b[^>]*\bsrc=["']([^"']+\.js[^"']*)["']/gi;
const LINK_PRELOAD_RE = /<link\b[^>]*\bhref=["']([^"']+\.js[^"']*)["'][^>]*>/gi;
const NEXT_CHUNK_RE = /["'(]((?:https?:\/\/[^"'()\s]+)?\/_next\/static\/[^"'()\s]+?\.js)["')]/g;
const URL_LITERAL_RE = /["'`](https?:\/\/[a-z0-9.-]+(?::\d{2,5})?(?:\/[A-Za-z0-9._~%/-]*)?)["'`]/gi;
/** Keys that usually hold the backend URL in env-inlined bundles. */
const API_CONTEXT_RE = /(api[_-]?(?:url|base|host|endpoint|origin|root)|backend[_-]?(?:url|host)?|server[_-]?url|base[_-]?url|baseURL|NEXT_PUBLIC_[A-Z_]*(?:API|BACKEND|SERVER)[A-Z_]*)/i;
/** Hosts that are never the media API. */
const IGNORED_HOSTS = /(^|\.)(supabase\.(co|in)|googleapis\.com|gstatic\.com|google\.com|googletagmanager\.com|google-analytics\.com|vercel\.(app|com|live|insights)|sentry\.io|w3\.org|reactjs\.org|react\.dev|nextjs\.org|github\.com|githubusercontent\.com|cloudflare\.com|cloudflareinsights\.com|jsdelivr\.net|unpkg\.com|fonts\.\w+|schema\.org|example\.(com|org)|localhost|mozilla\.org|apple\.com|facebook\.(com|net)|twitter\.com|x\.com|youtube\.com|stripe\.com|posthog\.com|intercom\.io|spotify\.com|scdn\.co|mzstatic\.com|tidal\.com|deezer\.com)$/i;

/** Decodes a JWT payload without verifying it (we only need the public `role`/`ref` claims). */
export function jwtPayload(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Supabase project ref from `https://<ref>.supabase.co`. */
function projectRef(url: string | undefined): string | undefined {
  return url?.match(/^https:\/\/([a-z0-9-]+)\.supabase\./i)?.[1]?.toLowerCase();
}

interface Findings {
  supabaseUrls: Map<string, number>;
  anonKeys: { key: string; ref?: string }[];
  apiCandidates: Map<string, number>;
  chunks: string[];
}

/** Scans one text blob (HTML or JS) and accumulates findings. Exported for tests. */
export function scanText(text: string, pageUrl: string, f: Findings = emptyFindings()): Findings {
  for (const m of text.matchAll(SUPABASE_URL_RE)) {
    const u = m[0].toLowerCase();
    f.supabaseUrls.set(u, (f.supabaseUrls.get(u) ?? 0) + 1);
  }
  for (const m of text.matchAll(JWT_RE)) {
    const p = jwtPayload(m[0]);
    if (p?.role === "anon" && !f.anonKeys.some((k) => k.key === m[0])) {
      f.anonKeys.push({ key: m[0], ref: typeof p.ref === "string" ? p.ref.toLowerCase() : undefined });
    }
  }
  for (const m of text.matchAll(PUBLISHABLE_RE)) {
    if (!f.anonKeys.some((k) => k.key === m[0])) f.anonKeys.push({ key: m[0] });
  }

  const base = new URL(pageUrl);
  for (const re of [SCRIPT_SRC_RE, LINK_PRELOAD_RE, NEXT_CHUNK_RE]) {
    for (const m of text.matchAll(re)) {
      const raw = m[1]!.replace(/\\u002F/gi, "/").replace(/&amp;/g, "&");
      try {
        const u = new URL(raw, base);
        // Same-origin assets only (plus Next.js static chunks on a CDN assetPrefix).
        if (u.origin !== base.origin && !u.pathname.includes("/_next/static/")) continue;
        if (!f.chunks.includes(u.toString())) f.chunks.push(u.toString());
      } catch {
        /* not a URL */
      }
    }
  }

  for (const m of text.matchAll(URL_LITERAL_RE)) {
    let u: URL;
    try {
      u = new URL(m[1]!);
    } catch {
      continue;
    }
    if (IGNORED_HOSTS.test(u.hostname) || u.pathname.includes("/_next/")) continue;
    if (/\.(png|jpe?g|webp|gif|svg|ico|css|js|woff2?|mp3|mp4|flac)$/i.test(u.pathname)) continue;
    const before = text.slice(Math.max(0, (m.index ?? 0) - 80), m.index ?? 0);
    let score = 0;
    if (API_CONTEXT_RE.test(before)) score += 5;
    if (/(^|\.)api\./i.test(u.hostname) || /^\/api(\/|$)/.test(u.pathname)) score += 3;
    if (u.hostname === base.hostname) score -= 1;
    if (score <= 0) continue;
    const key = u.toString().replace(/\/+$/, "");
    f.apiCandidates.set(key, Math.max(f.apiCandidates.get(key) ?? 0, score));
  }
  return f;
}

function emptyFindings(): Findings {
  return { supabaseUrls: new Map(), anonKeys: [], apiCandidates: new Map(), chunks: [] };
}

/** Chooses the best values from accumulated findings. Exported for tests. */
export function pickFindings(f: Findings, frontendUrl: string): Pick<DiscoveryResult, "supabaseUrl" | "anonKey" | "apiBase" | "apiBaseSource"> {
  const supabaseUrl = [...f.supabaseUrls.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const ref = projectRef(supabaseUrl);
  const anon = f.anonKeys.find((k) => ref && k.ref === ref) ?? f.anonKeys.find((k) => k.key.startsWith("eyJ")) ?? f.anonKeys[0];
  const best = [...f.apiCandidates.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  // Strip a trailing "/api" so MEDIA_SEARCH_PATH=/api/search composes correctly.
  const fromCode = best?.replace(/\/api$/i, "");
  return {
    supabaseUrl,
    anonKey: anon?.key,
    apiBase: fromCode ?? new URL(frontendUrl).origin,
    apiBaseSource: fromCode ? "code" : "frontend-origin",
  };
}

async function fetchText(url: string, fetchFn: typeof fetch, timeoutMs: number, maxBytes: number, signal: AbortSignal): Promise<string> {
  const res = await fetchFn(url, {
    headers: { accept: "text/html,application/javascript,*/*;q=0.8", "user-agent": "80s-web/0.1 (config discovery)" },
    redirect: "follow",
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
  });
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`HTTP ${res.status}`);
  }
  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error(`too large (${length} bytes)`);
  }
  // Read incrementally so a missing/lying content-length can't blow the memory budget.
  const reader = res.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let out = "";
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`too large (> ${maxBytes} bytes)`);
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/** Fetches the frontend page and its chunks, stopping as soon as all three values are found. */
export async function discoverFrontend(frontendUrl: string, opts: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const started = Date.now();
  const fetchFn = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  const maxChunks = opts.maxChunks ?? 60;
  const maxBytesPerFile = opts.maxBytesPerFile ?? 3 * 1024 * 1024;
  const maxTotalBytes = opts.maxTotalBytes ?? 20 * 1024 * 1024;
  const deadline = AbortSignal.timeout(opts.deadlineMs ?? 25_000);
  const findings = emptyFindings();
  const scanned: string[] = [];
  const errors: string[] = [];
  let total = 0;

  const scan = async (url: string) => {
    try {
      const text = await fetchText(url, fetchFn, timeoutMs, maxBytesPerFile, deadline);
      total += text.length;
      scanned.push(url);
      scanText(text, url, findings);
    } catch (err) {
      const e = err as Error;
      errors.push(`${url}: ${e.name === "TimeoutError" || e.name === "AbortError" ? "timed out" : e.message}`);
    }
  };

  await scan(frontendUrl);
  const complete = () =>
    findings.supabaseUrls.size > 0 && findings.anonKeys.length > 0 && [...findings.apiCandidates.values()].some((s) => s >= 5);

  // Chunks can reference more chunks (webpack runtime): walk the growing list, 4 at a time.
  let next = 0;
  while (next < findings.chunks.length && next < maxChunks && !complete() && !deadline.aborted && total < maxTotalBytes) {
    const batch = findings.chunks.slice(next, Math.min(next + 4, maxChunks));
    next += batch.length;
    await Promise.all(batch.map(scan));
  }
  if (deadline.aborted) errors.push("discovery deadline reached");

  return { frontendUrl, ...pickFindings(findings, frontendUrl), scanned, errors, durationMs: Date.now() - started };
}

/** Variables discovery can fill; explicit (non-blank) env values always win. */
export function needsDiscovery(env: Env): boolean {
  const blank = (k: string) => !env[k]?.trim();
  return Boolean(env.MEDIA_FRONTEND_URL?.trim()) && (blank("SUPABASE_URL") || blank("SUPABASE_ANON_KEY") || blank("MEDIA_API_BASE"));
}

/** Returns a copy of [env] with blank SUPABASE_URL / SUPABASE_ANON_KEY / MEDIA_API_BASE filled from [found]. */
export function applyDiscovery(env: Env, found: DiscoveryResult | undefined): { env: Env; filled: string[] } {
  if (!found) return { env, filled: [] };
  const out: Env = { ...env };
  const filled: string[] = [];
  const fill = (key: string, value: string | undefined) => {
    if (value && !env[key]?.trim()) {
      out[key] = value;
      filled.push(key);
    }
  };
  fill("SUPABASE_URL", found.supabaseUrl);
  fill("SUPABASE_ANON_KEY", found.anonKey);
  fill("MEDIA_API_BASE", found.apiBase);
  return { env: out, filled };
}
