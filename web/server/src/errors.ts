import type { ApiErrorBody, ErrorCode } from "../../shared/api.js";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  ACCESS_REQUIRED: 401,
  NOT_FOUND: 404,
  JOB_FAILED: 502,
  UPSTREAM_BAD_RESPONSE: 502,
  STREAM_UNAVAILABLE: 502,
  UPSTREAM_UNAVAILABLE: 503,
  UPSTREAM_AUTH_FAILED: 503,
  PROVIDER_BUSY: 503,
  NOT_CONFIGURED: 503,
  UPSTREAM_TIMEOUT: 504,
  JOB_TIMEOUT: 504,
  INTERNAL: 500,
};

/** Codes that indicate the provider is slow or down, so another one may help. */
const FAILOVER_CODES = new Set<ErrorCode>([
  "UPSTREAM_TIMEOUT",
  "JOB_TIMEOUT",
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_AUTH_FAILED",
  "PROVIDER_BUSY",
  "NOT_CONFIGURED",
]);

const RETRYABLE_CODES = new Set<ErrorCode>([
  "UPSTREAM_TIMEOUT",
  "JOB_TIMEOUT",
  "UPSTREAM_UNAVAILABLE",
  "PROVIDER_BUSY",
  "STREAM_UNAVAILABLE",
]);

export interface AppErrorOptions {
  upstreamStatus?: number;
  provider?: string;
  cause?: unknown;
}

/**
 * The one error type that crosses module boundaries. Messages are written for
 * end users and never contain tokens, signed URLs or upstream bodies.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly upstreamStatus?: number;
  readonly provider?: string;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.upstreamStatus = options.upstreamStatus;
    this.provider = options.provider;
  }

  get status(): number {
    return STATUS_BY_CODE[this.code];
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }

  toBody(): ApiErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.upstreamStatus !== undefined ? { upstreamStatus: this.upstreamStatus } : {}),
        retryable: this.retryable,
      },
    };
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** True when the error means "this provider is unhealthy", not "this track is bad". */
export function isFailoverEligible(err: unknown): boolean {
  return isAppError(err) && FAILOVER_CODES.has(err.code);
}

export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  return new AppError("INTERNAL", "Unexpected server error", { cause: err });
}
