/**
 * Tiny JSON field-mapping helpers.
 *
 * A *field spec* is one or more dot paths separated by `|`; the first path that
 * resolves to a non-empty value wins. Array indexes are plain segments:
 *   "artist.name|artists.0.name|artist"
 */
export function getPath(obj: unknown, path: string): unknown {
  if (path === "" || path === "$") return obj;
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      cur = Number.isInteger(i) ? cur[i] : undefined;
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

export function pick(obj: unknown, spec: string | undefined): unknown {
  if (!spec) return undefined;
  for (const path of spec.split("|").map((p) => p.trim()).filter(Boolean)) {
    const v = getPath(obj, path);
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

export function pickString(obj: unknown, spec: string | undefined): string | undefined {
  const v = pick(obj, spec);
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  // `artists: [{name}, {name}]` style credits → "A, B"
  if (Array.isArray(v)) {
    const names = v
      .map((x) => (typeof x === "string" ? x : typeof x === "object" && x ? (x as { name?: unknown }).name : undefined))
      .filter((x): x is string => typeof x === "string" && x.length > 0);
    return names.length ? names.join(", ") : undefined;
  }
  if (typeof v === "object" && v && typeof (v as { name?: unknown }).name === "string") {
    return (v as { name: string }).name;
  }
  return undefined;
}

export function pickNumber(obj: unknown, spec: string | undefined): number | undefined {
  const v = pick(obj, spec);
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** First array found among the candidate paths (or the value itself if it is an array). */
export function pickArray(obj: unknown, spec: string): unknown[] {
  if (Array.isArray(obj) && (spec === "" || spec === "$")) return obj;
  const v = pick(obj, spec);
  if (Array.isArray(v)) return v;
  return Array.isArray(obj) ? obj : [];
}
