import type { FetchFn } from "../lib/http.js";
import { renderDemoWav, type MockAudioProvider } from "../providers/mock.js";
import { parseRange } from "./range.js";

export const DEMO_SCHEME = "demo:";

/**
 * Demo mode streams synthetic WAV clips without a CDN. The mock provider hands
 * out `demo://audio/<id>` URLs and this fetch wrapper answers them in-process
 * — with real Range semantics — so the regular proxy path is exercised end to end.
 */
export function withDemoAudio(base: FetchFn, provider: MockAudioProvider): FetchFn {
  const cache = new Map<string, Buffer>();
  const bufferFor = (id: string): Buffer | undefined => {
    const hit = cache.get(id);
    if (hit) return hit;
    const track = provider.catalog.find((t) => t.id === id);
    if (!track) return undefined;
    const buf = renderDemoWav(id, track.durationSec ?? 30);
    cache.set(id, buf);
    while (cache.size > 6) cache.delete(cache.keys().next().value as string);
    return buf;
  };

  const demoFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(DEMO_SCHEME)) return base(input, init);
    const id = decodeURIComponent(url.replace(/^demo:\/\/audio\//, ""));
    const buf = bufferFor(id);
    if (!buf) return new Response("not found", { status: 404 });

    const headers = new Headers(init?.headers);
    const range = parseRange(headers.get("range") ?? undefined, buf.length);
    const common = { "content-type": "audio/wav", "accept-ranges": "bytes", etag: `"${id}-${buf.length}"` };
    if (range === null) {
      return new Response(null, { status: 416, headers: { ...common, "content-range": `bytes */${buf.length}` } });
    }
    if (range === undefined) {
      return new Response(new Uint8Array(buf), { status: 200, headers: { ...common, "content-length": String(buf.length) } });
    }
    const slice = buf.subarray(range.start, range.end + 1);
    return new Response(new Uint8Array(slice), {
      status: 206,
      headers: {
        ...common,
        "content-length": String(slice.length),
        "content-range": `bytes ${range.start}-${range.end}/${buf.length}`,
      },
    });
  };
  return demoFetch as FetchFn;
}
