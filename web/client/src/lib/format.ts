import type { Track } from "../../../shared/api";

export function formatDuration(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return "–:––";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "FLAC 24/96", "WAV 16/44.1", "FLAC", "MP3 320" … */
export function qualityLabel(t: Pick<Track, "format" | "lossless" | "bitDepth" | "sampleRate" | "bitrateKbps">): string {
  const fmt = (t.format ?? (t.lossless ? "lossless" : "")).toUpperCase();
  if (t.bitDepth && t.sampleRate) {
    const khz = t.sampleRate / 1000;
    return `${fmt} ${t.bitDepth}/${Number.isInteger(khz) ? khz : khz.toFixed(1)}`;
  }
  if (!t.lossless && t.bitrateKbps) return `${fmt} ${t.bitrateKbps}`;
  return fmt || "AUDIO";
}

export function isHiRes(t: Pick<Track, "bitDepth" | "sampleRate">): boolean {
  return (t.bitDepth ?? 0) >= 24 || (t.sampleRate ?? 0) > 48_000;
}

export function initials(text: string): string {
  return (
    text
      .split(/\s+/)
      .map((w) => Array.from(w)[0] ?? "")
      .join("")
      .slice(0, 2)
      .toUpperCase() || "♪"
  );
}

export function hueFor(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % 360;
}
