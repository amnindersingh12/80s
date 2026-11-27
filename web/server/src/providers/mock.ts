import { AppError } from "../errors.js";
import { normalizeText } from "../lib/text.js";
import type { AudioProvider, ProviderTrack, SearchOptions, StreamOptions, StreamSource } from "./types.js";

type Method = "search" | "getTrackMetadata" | "getStreamUrl";

export interface MockAudioProviderOptions {
  name?: string;
  tracks?: Array<Omit<ProviderTrack, "provider">>;
  /** Artificial latency for every call. */
  latencyMs?: number;
  /** Builds the upstream URL for a track (tests point this at a fake CDN). */
  streamUrl?: (id: string) => string;
  /** Stream source expiry, relative to now. */
  streamTtlMs?: number;
}

/**
 * Deterministic in-memory provider used by the unit tests and by demo mode.
 * Every method can be forced to fail or to hang (until aborted) so tests can
 * exercise timeouts, failover and concurrency without a network.
 */
export class MockAudioProvider implements AudioProvider {
  readonly name: string;
  readonly kind = "mock";
  readonly calls: Record<Method, number> = { search: 0, getTrackMetadata: 0, getStreamUrl: 0 };
  /** Calls currently in flight per method, plus the peak seen. */
  readonly active: Record<Method, number> = { search: 0, getTrackMetadata: 0, getStreamUrl: 0 };
  readonly peak: Record<Method, number> = { search: 0, getTrackMetadata: 0, getStreamUrl: 0 };

  private tracks: ProviderTrack[];
  private failures = new Map<Method, () => Error>();
  private hangs = new Set<Method>();
  private delays = new Map<Method, number>();
  private streamUrlFn: (id: string) => string;

  constructor(private readonly options: MockAudioProviderOptions = {}) {
    this.name = options.name ?? "mock";
    this.tracks = (options.tracks ?? DEMO_CATALOG).map((t) => ({ ...t, provider: this.name }));
    this.streamUrlFn = options.streamUrl ?? ((id) => `http://127.0.0.1/__mock/audio/${encodeURIComponent(id)}.wav`);
  }

  setStreamUrl(fn: (id: string) => string): void {
    this.streamUrlFn = fn;
  }

  /** Make `method` throw (pass `undefined` to clear). */
  fail(method: Method, error?: Error | (() => Error)): this {
    if (!error) this.failures.delete(method);
    else this.failures.set(method, typeof error === "function" ? error : () => error);
    return this;
  }

  /** Make `method` never resolve (until its AbortSignal fires). */
  hang(method: Method, on = true): this {
    if (on) this.hangs.add(method);
    else this.hangs.delete(method);
    return this;
  }

  /** Per-method latency override. */
  delay(method: Method, ms: number): this {
    this.delays.set(method, ms);
    return this;
  }

  get catalog(): readonly ProviderTrack[] {
    return this.tracks;
  }

  async search(query: string, options: SearchOptions = {}): Promise<ProviderTrack[]> {
    return this.invoke("search", options.signal, () => {
      const terms = normalizeText(query).split(" ").filter(Boolean);
      if (!terms.length) return [];
      const hits = this.tracks.filter((t) => {
        const hay = normalizeText(`${t.title} ${t.artist} ${t.album ?? ""}`);
        return terms.every((term) => hay.includes(term));
      });
      return structuredClone(hits.slice(0, options.limit ?? 25));
    });
  }

  async getTrackMetadata(id: string): Promise<ProviderTrack | null> {
    return this.invoke("getTrackMetadata", undefined, () => {
      const t = this.tracks.find((x) => x.id === id);
      return t ? structuredClone(t) : null;
    });
  }

  async getStreamUrl(id: string, options: StreamOptions = {}): Promise<StreamSource> {
    return this.invoke("getStreamUrl", options.signal, () => {
      const t = this.tracks.find((x) => x.id === id);
      if (!t) throw new AppError("NOT_FOUND", "Track not found", { provider: this.name });
      options.onProgress?.({ stage: "ready", progress: 1 });
      const ext = t.format ?? "wav";
      return {
        url: this.streamUrlFn(id),
        mimeType: ext === "flac" ? "audio/flac" : "audio/wav",
        extension: ext,
        ...(this.options.streamTtlMs ? { expiresAt: Date.now() + this.options.streamTtlMs } : {}),
      };
    });
  }

  private async invoke<T>(method: Method, signal: AbortSignal | undefined, fn: () => T): Promise<T> {
    this.calls[method]++;
    this.active[method]++;
    this.peak[method] = Math.max(this.peak[method], this.active[method]);
    try {
      const ms = this.delays.get(method) ?? this.options.latencyMs ?? 0;
      if (this.hangs.has(method)) {
        await new Promise<never>((_, reject) => {
          if (signal?.aborted) reject(signal.reason);
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
      const failure = this.failures.get(method);
      if (failure) throw failure();
      return fn();
    } finally {
      this.active[method]--;
    }
  }
}

// ------------------------------------------------------------- demo data ---

type DemoSeed = [artist: string, title: string, album: string, year: number];

const DEMO_SEEDS: DemoSeed[] = [
  ["Diljit Dosanjh", "Lover", "MoonChild Era", 2021],
  ["Diljit Dosanjh", "G.O.A.T.", "G.O.A.T.", 2020],
  ["Diljit Dosanjh", "Born To Shine", "G.O.A.T.", 2020],
  ["AP Dhillon", "Brown Munde", "Brown Munde", 2020],
  ["AP Dhillon", "Excuses", "Hidden Gems", 2020],
  ["AP Dhillon", "With You", "With You", 2023],
  ["Karan Aujla", "Softly", "Making Memories", 2023],
  ["Sidhu Moose Wala", "295", "Moosetape", 2021],
  ["Shubh", "We Rollin", "We Rollin", 2021],
  ["Arctic Monkeys", "Do I Wanna Know?", "AM", 2013],
  ["Arctic Monkeys", "505", "Favourite Worst Nightmare", 2007],
  ["Radiohead", "Karma Police", "OK Computer", 1997],
  ["Radiohead", "No Surprises", "OK Computer", 1997],
  ["Tame Impala", "The Less I Know The Better", "Currents", 2015],
  ["The Strokes", "Reptilia", "Room on Fire", 2003],
  ["Kendrick Lamar", "HUMBLE.", "DAMN.", 2017],
  ["Kendrick Lamar", "Money Trees", "good kid, m.A.A.d city", 2012],
  ["J. Cole", "No Role Modelz", "2014 Forest Hills Drive", 2014],
  ["a-ha", "Take On Me", "Hunting High and Low", 1985],
  ["Tears for Fears", "Everybody Wants to Rule the World", "Songs from the Big Chair", 1985],
  ["Depeche Mode", "Enjoy the Silence", "Violator", 1990],
  ["The Cure", "Just Like Heaven", "Kiss Me, Kiss Me, Kiss Me", 1987],
  ["New Order", "Blue Monday", "Power, Corruption & Lies", 1983],
  ["The Midnight", "Sunset", "Days of Thunder", 2014],
  ["FM-84", "Running in the Night", "Atlas", 2016],
  ["Kavinsky", "Nightcall", "OutRun", 2010],
];

/** Length of each synthetic demo clip, varied a little per track. */
export function demoDurationSec(index: number): number {
  return 24 + ((index * 7) % 13);
}

export const DEMO_CATALOG: Array<Omit<ProviderTrack, "provider">> = DEMO_SEEDS.map(([artist, title, album, year], i) => ({
  id: `demo-${String(i + 1).padStart(2, "0")}`,
  title,
  artist,
  album,
  year,
  durationSec: demoDurationSec(i),
  coverUrl: `/__mock/cover/demo-${String(i + 1).padStart(2, "0")}.svg`,
  format: "wav",
  lossless: true,
  bitDepth: 16,
  sampleRate: 44_100,
}));

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Renders a short, pleasant stereo arpeggio as a 16-bit/44.1 kHz WAV so the
 * demo exercises real decoding, buffering and Range seeking in the browser.
 */
export function renderDemoWav(id: string, seconds: number, sampleRate = 44_100): Buffer {
  const seed = hashString(id);
  const channels = 2;
  const frames = Math.floor(seconds * sampleRate);
  const dataBytes = frames * channels * 2;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);

  const root = 196 * 2 ** ((seed % 7) / 12); // G3 ± a few semitones
  const bpm = 84 + (seed % 5) * 8;
  const step = (60 / bpm) / 2; // eighth notes
  const scale = [0, 2, 4, 7, 9, 12, 14, 16]; // major pentatonic-ish
  const progression = [0, 5, 3, 4].map((d) => [0, 4, 7, 9, 5, 3, 7, 2][(d + seed) % 8] as number);

  for (let f = 0; f < frames; f++) {
    const t = f / sampleRate;
    const n = Math.floor(t / step);
    const inNote = t - n * step;
    const bar = Math.floor(n / 8) % progression.length;
    const degree = scale[(n * 3 + (seed >> 3)) % scale.length] as number;
    const freq = root * 2 ** ((degree + (progression[bar] as number)) / 12);
    const env = Math.min(1, inNote / 0.008) * Math.exp(-inNote * 5);
    const lead = Math.sin(2 * Math.PI * freq * t) + 0.25 * Math.sin(4 * Math.PI * freq * t);
    const bassF = (root / 2) * 2 ** ((progression[bar] as number) / 12);
    const bass = 0.55 * Math.sin(2 * Math.PI * bassF * t);
    const fade = Math.min(1, t / 0.5, (seconds - t) / 1.5);
    const pan = 0.5 + 0.35 * Math.sin(n * 0.9);
    const left = (lead * env * (1 - pan) + bass * 0.5) * 0.32 * fade;
    const right = (lead * env * pan + bass * 0.5) * 0.32 * fade;
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left)) * 32767), 44 + f * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right)) * 32767), 46 + f * 4);
  }
  return buf;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] as string);
}

/** Generated album-art placeholder for demo tracks. */
export function renderDemoCover(track: Pick<ProviderTrack, "id" | "title" | "artist">): string {
  const h = hashString(track.id + track.artist);
  const hue1 = h % 360;
  const hue2 = (hue1 + 40 + (h % 80)) % 360;
  const initials = track.title
    .split(/\s+/)
    .map((w) => Array.from(w)[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="300" height="300">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="hsl(${hue1} 70% 45%)"/><stop offset="1" stop-color="hsl(${hue2} 75% 22%)"/></linearGradient></defs>
<rect width="300" height="300" fill="url(#g)"/>
${Array.from({ length: 6 }, (_, i) => `<rect x="0" y="${190 + i * 14}" width="300" height="${2 + i}" fill="rgba(255,255,255,${0.05 + i * 0.03})"/>`).join("")}
<circle cx="150" cy="128" r="70" fill="rgba(255,255,255,0.10)"/>
<text x="150" y="150" text-anchor="middle" font-family="system-ui,sans-serif" font-size="64" font-weight="700" fill="rgba(255,255,255,0.92)">${escapeXml(initials)}</text>
<text x="20" y="282" font-family="system-ui,sans-serif" font-size="15" fill="rgba(255,255,255,0.8)">${escapeXml(track.artist).slice(0, 34)}</text>
</svg>`;
}
