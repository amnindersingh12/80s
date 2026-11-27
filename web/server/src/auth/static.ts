import type { TokenSource } from "../providers/remote.js";

/** `MEDIA_AUTH_MODE=none`: guest/public media API, no Authorization header at all. */
export class NoAuth implements TokenSource {
  readonly mode = "none" as const;
  readonly refreshable = false;
  async getAccessToken(): Promise<undefined> {
    return undefined;
  }
  invalidate(): void {}
}

/** `MEDIA_AUTH_MODE=bearer`: a fixed `MEDIA_BEARER_TOKEN`, never refreshed. */
export class StaticBearer implements TokenSource {
  readonly mode = "bearer" as const;
  readonly refreshable = false;
  constructor(private readonly token: string) {}
  async getAccessToken(): Promise<string> {
    return this.token;
  }
  invalidate(): void {}
}
