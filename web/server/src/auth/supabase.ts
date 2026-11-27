import { AppError } from "../errors.js";
import { AsyncLock } from "../lib/concurrency.js";
import { requestJson, type FetchFn } from "../lib/http.js";
import type { SupabaseConfig } from "../config.js";

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  /** Seconds since epoch. */
  expires_at?: number;
  error?: string;
  error_description?: string;
  msg?: string;
}

interface Session {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
}

export interface SupabaseAuthOptions extends SupabaseConfig {
  fetch?: FetchFn;
  now?: () => number;
  /** Proactively refresh `refreshMarginMs` before expiry on a timer (default true). */
  autoRefresh?: boolean;
  onError?: (err: unknown) => void;
}

export interface AuthStats {
  passwordGrants: number;
  refreshGrants: number;
  cacheHits: number;
}

/**
 * Supabase GoTrue session manager for the media server.
 *
 * - The access token is cached in memory; every read goes through an
 *   `AsyncLock`, so N concurrent requests trigger at most one grant.
 * - Tokens are refreshed with `grant_type=refresh_token` once they are within
 *   `refreshMarginMs` (60 s) of expiry — lazily on read and proactively on a
 *   timer — and Supabase's rotated refresh token is kept.
 * - If refreshing fails (revoked/rotated token) it falls back to the password
 *   grant when credentials are configured.
 */
export class SupabaseAuth {
  private session: Session | undefined;
  private readonly lock = new AsyncLock();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  readonly stats: AuthStats = { passwordGrants: 0, refreshGrants: 0, cacheHits: 0 };

  private readonly fetchFn: FetchFn;
  private readonly now: () => number;
  private seedRefreshToken: string | undefined;

  constructor(private readonly options: SupabaseAuthOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.seedRefreshToken = options.refreshToken;
  }

  /** Returns a valid access token, authenticating or refreshing if needed. */
  async getAccessToken(): Promise<string> {
    const cached = this.validSession();
    if (cached) {
      this.stats.cacheHits++;
      return cached.accessToken;
    }
    return this.lock.run(async () => {
      // Another caller may have refreshed while we waited for the lock.
      const fresh = this.validSession();
      if (fresh) {
        this.stats.cacheHits++;
        return fresh.accessToken;
      }
      const session = await this.obtainSession();
      this.session = session;
      this.scheduleRefresh(session);
      return session.accessToken;
    });
  }

  /**
   * Drop the cached access token (e.g. after the media API answered 401) while
   * keeping the refresh token, so the next call refreshes instead of re-logging in.
   */
  invalidate(rejectedToken?: string): void {
    if (rejectedToken && this.session && this.session.accessToken !== rejectedToken) return;
    if (this.session) {
      this.seedRefreshToken = this.session.refreshToken ?? this.seedRefreshToken;
      this.session = undefined;
    }
  }

  /** Epoch ms when the cached token expires, if any (for health output). */
  get expiresAt(): number | undefined {
    return this.session?.expiresAt;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private validSession(): Session | undefined {
    const s = this.session;
    if (s && this.now() < s.expiresAt - this.options.refreshMarginMs) return s;
    return undefined;
  }

  private async obtainSession(): Promise<Session> {
    const refreshToken = this.session?.refreshToken ?? this.seedRefreshToken;
    if (refreshToken) {
      try {
        return await this.grant("refresh_token", { refresh_token: refreshToken });
      } catch (err) {
        // A transport failure means Supabase itself is unreachable: retrying with
        // the password would hit the same wall, so surface it as-is.
        const rejected = err instanceof AppError && err.code === "UPSTREAM_AUTH_FAILED";
        if (!rejected || !this.hasPassword()) throw err;
        this.options.onError?.(err);
        this.seedRefreshToken = undefined;
      }
    }
    if (!this.hasPassword()) {
      throw new AppError("UPSTREAM_AUTH_FAILED", "No valid media server session and no password configured", {
        provider: "remote",
      });
    }
    return this.grant("password", { email: this.options.email, password: this.options.password });
  }

  private hasPassword(): boolean {
    return Boolean(this.options.email && this.options.password);
  }

  private async grant(type: "password" | "refresh_token", body: Record<string, unknown>): Promise<Session> {
    if (type === "password") this.stats.passwordGrants++;
    else this.stats.refreshGrants++;

    const url = `${this.options.url.replace(/\/+$/, "")}/auth/v1/token?grant_type=${type}`;
    const res = await requestJson<TokenResponse>(url, {
      method: "POST",
      headers: { apikey: this.options.anonKey },
      body,
      timeoutMs: this.options.timeoutMs,
      retries: 0,
      fetch: this.fetchFn,
      label: type === "password" ? "Media server sign-in" : "Media server token refresh",
      provider: "remote",
    });

    const data = res.data ?? {};
    if (res.status < 200 || res.status >= 300 || !data.access_token) {
      const reason = data.error_description ?? data.msg ?? data.error ?? `HTTP ${res.status}`;
      throw new AppError("UPSTREAM_AUTH_FAILED", `Media server ${type === "password" ? "sign-in" : "token refresh"} rejected: ${reason}`, {
        upstreamStatus: res.status,
        provider: "remote",
      });
    }

    const now = this.now();
    const expiresAt =
      typeof data.expires_at === "number"
        ? data.expires_at * 1000
        : now + (typeof data.expires_in === "number" ? data.expires_in : 3600) * 1000;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? (type === "refresh_token" ? (body.refresh_token as string) : undefined),
      expiresAt,
    };
  }

  private scheduleRefresh(session: Session): void {
    if (this.options.autoRefresh === false || this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = session.expiresAt - this.options.refreshMarginMs - this.now();
    // Refresh lazily on next read if the token is already inside the margin.
    if (delay <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed) return;
      this.getAccessToken().catch((err) => this.options.onError?.(err));
    }, Math.min(delay, 2 ** 31 - 1));
    this.timer.unref?.();
  }
}
