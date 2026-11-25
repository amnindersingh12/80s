import { afterEach, describe, expect, it, vi } from "vitest";
import { SupabaseAuth, type SupabaseAuthOptions } from "../src/auth/supabase.js";
import { AppError } from "../src/errors.js";

interface Call {
  url: string;
  grant: string | null;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** Fake GoTrue endpoint: hands out at-1, at-2… with rotating refresh tokens. */
function fakeGoTrue(opts: { ttlSec?: number; rejectRefresh?: boolean; delayMs?: number; hang?: boolean } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const grant = new URL(url).searchParams.get("grant_type");
    calls.push({ url, grant, body, headers: init?.headers as Record<string, string> });
    if (opts.hang) {
      await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (grant === "refresh_token" && opts.rejectRefresh) {
      return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Refresh Token Not Found" }), { status: 400 });
    }
    n++;
    return new Response(
      JSON.stringify({ access_token: `at-${n}`, expires_in: opts.ttlSec ?? 3600, refresh_token: `rt-${n}`, token_type: "bearer" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return { fetchFn, calls };
}

function makeAuth(fetchFn: typeof fetch, clock: { t: number }, extra: Partial<SupabaseAuthOptions> = {}) {
  return new SupabaseAuth({
    url: "https://proj.supabase.co",
    anonKey: "anon-key",
    email: "me@example.com",
    password: "pw",
    refreshMarginMs: 60_000,
    timeoutMs: 15_000,
    fetch: fetchFn,
    now: () => clock.t,
    autoRefresh: false,
    ...extra,
  });
}

describe("SupabaseAuth — JWT caching & refresh", () => {
  afterEach(() => vi.useRealTimers());

  it("signs in with the password grant and sends apikey + credentials", async () => {
    const { fetchFn, calls } = fakeGoTrue();
    const auth = makeAuth(fetchFn as unknown as typeof fetch, { t: 0 });
    expect(await auth.getAccessToken()).toBe("at-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://proj.supabase.co/auth/v1/token?grant_type=password");
    expect(calls[0]!.headers.apikey).toBe("anon-key");
    expect(calls[0]!.body).toEqual({ email: "me@example.com", password: "pw" });
  });

  it("serves the cached token until 60 s before expiry", async () => {
    const { fetchFn, calls } = fakeGoTrue({ ttlSec: 3600 });
    const clock = { t: 1_000_000 };
    const auth = makeAuth(fetchFn as unknown as typeof fetch, clock);
    await auth.getAccessToken();
    clock.t += 3600_000 - 61_000; // 61 s left → still cached
    expect(await auth.getAccessToken()).toBe("at-1");
    expect(calls).toHaveLength(1);
    expect(auth.stats.cacheHits).toBe(1);
  });

  it("refreshes with grant_type=refresh_token inside the 60 s window and keeps the rotated token", async () => {
    const { fetchFn, calls } = fakeGoTrue({ ttlSec: 3600 });
    const clock = { t: 1_000_000 };
    const auth = makeAuth(fetchFn as unknown as typeof fetch, clock);
    await auth.getAccessToken();
    clock.t += 3600_000 - 59_000; // 59 s left → refresh
    expect(await auth.getAccessToken()).toBe("at-2");
    expect(calls[1]!.grant).toBe("refresh_token");
    expect(calls[1]!.body).toEqual({ refresh_token: "rt-1" });

    clock.t += 3600_000; // again: must use the *rotated* refresh token
    expect(await auth.getAccessToken()).toBe("at-3");
    expect(calls[2]!.body).toEqual({ refresh_token: "rt-2" });
    expect(auth.stats).toMatchObject({ passwordGrants: 1, refreshGrants: 2 });
  });

  it("coalesces concurrent callers behind the async lock (one grant for 25 callers)", async () => {
    const { fetchFn, calls } = fakeGoTrue({ delayMs: 20 });
    const auth = makeAuth(fetchFn as unknown as typeof fetch, { t: 0 });
    const tokens = await Promise.all(Array.from({ length: 25 }, () => auth.getAccessToken()));
    expect(new Set(tokens)).toEqual(new Set(["at-1"]));
    expect(calls).toHaveLength(1);
  });

  it("coalesces concurrent refreshes too", async () => {
    const { fetchFn, calls } = fakeGoTrue({ delayMs: 10 });
    const clock = { t: 0 };
    const auth = makeAuth(fetchFn as unknown as typeof fetch, clock);
    await auth.getAccessToken();
    clock.t += 3600_000;
    await Promise.all(Array.from({ length: 10 }, () => auth.getAccessToken()));
    expect(calls.map((c) => c.grant)).toEqual(["password", "refresh_token"]);
  });

  it("falls back to the password grant when the refresh token is rejected", async () => {
    const { fetchFn, calls } = fakeGoTrue({ rejectRefresh: true });
    const clock = { t: 0 };
    const onError = vi.fn();
    const auth = makeAuth(fetchFn as unknown as typeof fetch, clock, { onError });
    await auth.getAccessToken();
    clock.t += 3600_000;
    expect(await auth.getAccessToken()).toBe("at-2");
    expect(calls.map((c) => c.grant)).toEqual(["password", "refresh_token", "password"]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it("seeds the session from MEDIA_REFRESH_TOKEN without ever sending the password", async () => {
    const { fetchFn, calls } = fakeGoTrue();
    const auth = makeAuth(fetchFn as unknown as typeof fetch, { t: 0 }, { refreshToken: "rt-seed", email: undefined, password: undefined });
    expect(await auth.getAccessToken()).toBe("at-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.grant).toBe("refresh_token");
    expect(calls[0]!.body).toEqual({ refresh_token: "rt-seed" });
  });

  it("fails cleanly when only a rejected refresh token is configured", async () => {
    const { fetchFn } = fakeGoTrue({ rejectRefresh: true });
    const auth = makeAuth(fetchFn as unknown as typeof fetch, { t: 0 }, { refreshToken: "rt-dead", email: undefined, password: undefined });
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "UPSTREAM_AUTH_FAILED", status: 503 });
  });

  it("invalidate() after a 401 refreshes instead of logging in again", async () => {
    const { fetchFn, calls } = fakeGoTrue();
    const auth = makeAuth(fetchFn as unknown as typeof fetch, { t: 0 });
    const first = await auth.getAccessToken();
    auth.invalidate(first);
    expect(await auth.getAccessToken()).toBe("at-2");
    expect(calls.map((c) => c.grant)).toEqual(["password", "refresh_token"]);
  });

  it("ignores invalidate() for a token that was already replaced", async () => {
    const { fetchFn, calls } = fakeGoTrue();
    const auth = makeAuth(fetchFn as unknown as typeof fetch, { t: 0 });
    await auth.getAccessToken();
    auth.invalidate("at-old");
    await auth.getAccessToken();
    expect(calls).toHaveLength(1);
  });

  it("enforces the auth timeout and reports a 504", async () => {
    const { fetchFn } = fakeGoTrue({ hang: true });
    const auth = makeAuth(fetchFn as unknown as typeof fetch, { t: 0 }, { timeoutMs: 50 });
    const started = Date.now();
    const err = await auth.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "UPSTREAM_TIMEOUT", status: 504 });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("proactively refreshes on a timer 60 s before expiry", async () => {
    vi.useFakeTimers({ now: 0 });
    const { fetchFn, calls } = fakeGoTrue({ ttlSec: 600 });
    const auth = new SupabaseAuth({
      url: "https://proj.supabase.co",
      anonKey: "anon-key",
      email: "me@example.com",
      password: "pw",
      refreshMarginMs: 60_000,
      timeoutMs: 15_000,
      fetch: fetchFn as unknown as typeof fetch,
    });
    await auth.getAccessToken();
    await vi.advanceTimersByTimeAsync(539_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000); // crosses expiry − 60 s
    expect(calls.map((c) => c.grant)).toEqual(["password", "refresh_token"]);
    expect(auth.stats.cacheHits).toBe(0);
    auth.close();
  });
});
