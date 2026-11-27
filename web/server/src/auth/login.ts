import { AppError } from "../errors.js";
import { AsyncLock } from "../lib/concurrency.js";
import { jwtPayload } from "../lib/discovery.js";
import { pickString } from "../lib/fields.js";
import { requestJson, type FetchFn } from "../lib/http.js";
import type { TokenSource } from "../providers/remote.js";

export interface LoginAuthOptions {
  loginUrl: string;
  email: string;
  password: string;
  refreshMarginMs: number;
  timeoutMs: number;
  fetch?: FetchFn;
  now?: () => number;
}

/**
 * `MEDIA_AUTH_MODE=login`: self-hosted email/password login (`POST {loginUrl}` with
 * `{ email, password }`) returning a bearer JWT (`token` / `access_token`).
 * Caches the token in memory behind an `AsyncLock` until `refreshMarginMs` before
 * its `exp` claim (or 1 h if the token has no `exp`), and re-logs in on 401.
 */
export class LoginAuth implements TokenSource {
  private session: { token: string; expiresAt: number } | undefined;
  private readonly lock = new AsyncLock();
  private readonly fetchFn: FetchFn;
  private readonly now: () => number;

  constructor(private readonly options: LoginAuthOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    const cached = this.validSession();
    if (cached) return cached.token;
    return this.lock.run(async () => {
      const fresh = this.validSession();
      if (fresh) return fresh.token;
      const session = await this.login();
      this.session = session;
      return session.token;
    });
  }

  invalidate(rejectedToken?: string): void {
    if (rejectedToken && this.session && this.session.token !== rejectedToken) return;
    this.session = undefined;
  }

  private validSession() {
    const s = this.session;
    if (s && this.now() < s.expiresAt - this.options.refreshMarginMs) return s;
    return undefined;
  }

  private async login(): Promise<{ token: string; expiresAt: number }> {
    const res = await requestJson<Record<string, unknown>>(this.options.loginUrl, {
      method: "POST",
      body: { email: this.options.email, password: this.options.password },
      timeoutMs: this.options.timeoutMs,
      retries: 0,
      fetch: this.fetchFn,
      label: "Media server login",
      provider: "remote",
    });

    const token = pickString(res.data, "token|access_token|data.token|data.access_token");
    if (res.status < 200 || res.status >= 300 || !token) {
      const reason = pickString(res.data, "error|message|error_description") ?? `HTTP ${res.status}`;
      throw new AppError("UPSTREAM_AUTH_FAILED", `Media server login rejected: ${reason}`, {
        upstreamStatus: res.status,
        provider: "remote",
      });
    }

    const exp = jwtPayload(token)?.exp;
    const expiresAt = typeof exp === "number" ? exp * 1000 : this.now() + 3_600_000;
    return { token, expiresAt };
  }
}
