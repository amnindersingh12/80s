export interface LrcLine {
  timeSec: number;
  text: string;
}

const TIMESTAMP_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** Parses LRC synced lyrics (`[mm:ss.xx] Line`) into chronological lines. */
export function parseLrc(raw: string | null | undefined): LrcLine[] {
  if (!raw) return [];
  const out: LrcLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    TIMESTAMP_RE.lastIndex = 0;
    const times: number[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TIMESTAMP_RE.exec(line)) !== null) {
      const min = Number(match[1]);
      const sec = Number(match[2]);
      const fracRaw = match[3] ?? "0";
      const frac = Number(fracRaw) / 10 ** fracRaw.length;
      times.push(min * 60 + sec + frac);
      lastIndex = match.index + match[0].length;
    }
    if (!times.length) continue;
    const text = line.slice(lastIndex).trim();
    if (!text) continue;
    for (const timeSec of times) out.push({ timeSec, text });
  }
  return out.sort((a, b) => a.timeSec - b.timeSec);
}

/** Binary search for the active lyric line index at `positionSec`. */
export function activeLrcIndex(lines: readonly LrcLine[], positionSec: number): number {
  if (!lines.length || positionSec < (lines[0]?.timeSec ?? 0)) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (lines[mid]!.timeSec <= positionSec + 0.12) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}
