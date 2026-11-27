import { createHmac, timingSafeEqual } from "node:crypto";

export const DEFAULT_STREAM_TOKEN_TTL_SEC = 3600;

/** Creates an HMAC-SHA256 query token `<expSec>.<sig>` bound to a track id. */
export function signStreamToken(
  id: string,
  secret: string,
  nowMs = Date.now(),
  ttlSec = DEFAULT_STREAM_TOKEN_TTL_SEC,
): string {
  const exp = Math.floor(nowMs / 1000) + ttlSec;
  const sig = createHmac("sha256", secret).update(`${id}:${exp}`).digest("base64url");
  return `${exp}.${sig}`;
}

/** Verifies `<expSec>.<sig>` against the given track id and current time. */
export function verifyStreamToken(
  id: string,
  token: string,
  secret: string,
  nowMs = Date.now(),
): boolean {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return false;
  const expStr = token.slice(0, dot);
  const sigStr = token.slice(dot + 1);
  if (!/^\d+$/.test(expStr)) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= Math.floor(nowMs / 1000)) return false;

  const expected = createHmac("sha256", secret).update(`${id}:${expStr}`).digest("base64url");
  const a = Buffer.from(sigStr);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Returns `/api/stream/:id` with `?st=<exp>.<sig>` when `secret` is configured. */
export function buildSignedStreamUrl(
  id: string,
  secret?: string,
  nowMs = Date.now(),
  ttlSec = DEFAULT_STREAM_TOKEN_TTL_SEC,
): string {
  const base = `/api/stream/${encodeURIComponent(id)}`;
  if (!secret) return base;
  return `${base}?st=${signStreamToken(id, secret, nowMs, ttlSec)}`;
}
