import { AppError } from "../errors.js";

export type FetchFn = typeof fetch;

export interface JsonRequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  /** Serialised as JSON when present. */
  body?: unknown;
  /** Per-attempt timeout covering the response headers *and* body. */
  timeoutMs: number;
  /** Extra attempts on transient failures (timeout, network error, 5xx, 429). */
  retries?: number;
  retryDelayMs?: number;
  /** Outer cancellation (e.g. an overall job deadline). Never retried. */
  signal?: AbortSignal;
  fetch?: FetchFn;
  /** Human label used in error messages, e.g. "media search". */
  label: string;
  provider?: string;
}

export interface JsonResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
}

/** Marker so callers can tell "our timer fired" from "the caller aborted". */
class AttemptTimeout extends Error {}

function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408;
}

/** Parses `retryAfterSeconds` from JSON or `Retry-After` header, defaulting to 60 s. */
export function parseRetryAfterMs(headers: Headers, body?: unknown, fallbackMs = 60_000): number {
  if (body && typeof body === "object") {
    const sec = (body as Record<string, unknown>).retryAfterSeconds ?? (body as Record<string, unknown>).retry_after;
    if (typeof sec === "number" && Number.isFinite(sec) && sec > 0) return Math.round(sec * 1000);
  }
  const h = headers.get("retry-after");
  if (h) {
    const n = Number(h);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1000);
    const t = Date.parse(h);
    if (!Number.isNaN(t) && t > Date.now()) return t - Date.now();
  }
  return fallbackMs;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * JSON request with a hard per-attempt timeout and bounded retries on
 * transient failures. Non-transient HTTP statuses (2xx–4xx) are returned to the
 * caller untouched so it can react to 401/404 itself; transient failures that
 * survive all retries become clean `AppError`s (504 timeout / 503 unavailable).
 */
export async function requestJson<T = unknown>(
  url: string,
  options: JsonRequestOptions,
): Promise<JsonResponse<T>> {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs,
    retries = 0,
    retryDelayMs = 250,
    signal,
    fetch: fetchFn = fetch,
    label,
    provider,
  } = options;

  let lastError: AppError | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs * attempt, signal);
    if (signal?.aborted) throw signal.reason;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new AttemptTimeout()), timeoutMs);
    const onOuterAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onOuterAbort, { once: true });

    try {
      const res = await fetchFn(url, {
        method,
        headers: {
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (isTransientStatus(res.status)) {
        await res.body?.cancel().catch(() => undefined);
        lastError = new AppError(
          res.status === 429 ? "PROVIDER_BUSY" : "UPSTREAM_UNAVAILABLE",
          `${label} failed: upstream returned ${res.status}`,
          { upstreamStatus: res.status, provider },
        );
        continue;
      }

      const text = await res.text();
      let data: unknown = null;
      if (text.length > 0) {
        try {
          data = JSON.parse(text);
        } catch (cause) {
          throw new AppError("UPSTREAM_BAD_RESPONSE", `${label} returned invalid JSON`, {
            upstreamStatus: res.status,
            provider,
            cause,
          });
        }
      }
      return { status: res.status, headers: res.headers, data: data as T };
    } catch (err) {
      if (err instanceof AppError) throw err;
      const reason = controller.signal.reason;
      if (reason instanceof AttemptTimeout) {
        lastError = new AppError("UPSTREAM_TIMEOUT", `${label} timed out after ${timeoutMs} ms`, {
          provider,
        });
        continue;
      }
      if (signal?.aborted) throw signal.reason;
      lastError = new AppError("UPSTREAM_UNAVAILABLE", `${label} failed: upstream unreachable`, {
        provider,
        cause: err,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    }
  }
  throw lastError ?? new AppError("UPSTREAM_UNAVAILABLE", `${label} failed`, { provider });
}

/** Join a base URL and a path without doubling or dropping slashes. */
export function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** Replace `:name` placeholders in a path template with URL-encoded values. */
export function fillPath(template: string, params: Record<string, string>): string {
  return template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) =>
    name in params ? encodeURIComponent(params[name] as string) : match,
  );
}
