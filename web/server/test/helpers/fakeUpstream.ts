import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { parseRange } from "../../src/services/range.js";

/**
 * One local HTTP server that plays three roles for tests:
 *   - Supabase GoTrue:   POST /auth/v1/token?grant_type=password|refresh_token
 *   - the media server:  GET /api/search, POST /api/download, GET /api/jobs/:id, GET /api/tracks/:id
 *   - an R2-style CDN:   GET /cdn/:file (Range aware, signed with ?sig=…)
 * Behaviour is driven by the mutable `state` object.
 */
export interface FakeState {
  tokenTtlSec: number;
  issued: number;
  validTokens: Set<string>;
  authCalls: Array<{ grant: string; body: Record<string, unknown>; apikey?: string }>;
  searchCalls: Array<{ url: URL; auth?: string }>;
  searchResponse: unknown;
  searchDelayMs: number;
  /** Respond 401 to the next N media requests (token revoked). */
  rejectNextMediaRequests: number;
  jobs: Map<string, { trackId: string; polls: number }>;
  jobCreateBodies: unknown[];
  /** How many polls until the job reports completed (Infinity = never). */
  pollsUntilDone: number;
  jobCreateResponse?: (trackId: string, jobId: string) => unknown;
  jobStatusOverride?: (job: { trackId: string; polls: number }, jobId: string) => unknown;
  /** Next N job-status requests fail with 500 / hang. */
  failNextPolls: number;
  hangNextPolls: number;
  activeJobs: number;
  peakActiveJobs: number;
  signedUrlFor: (trackId: string) => string;
  cdnFiles: Map<string, { body: Buffer; type: string }>;
  cdnRequests: Array<{ path: string; range?: string; method: string; auth?: string }>;
  /** Only `?sig=<value>` in this set is accepted by the CDN (others get 403). */
  validSignatures: Set<string>;
  cdnAcceptRanges: boolean;
  cdnSlowStreamMs: number;
  cdnClosedEarly: number;
}

export interface FakeUpstream {
  url: string;
  state: FakeState;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

export async function startFakeUpstream(overrides: Partial<FakeState> = {}): Promise<FakeUpstream> {
  let base = "";
  const state: FakeState = {
    tokenTtlSec: 3600,
    issued: 0,
    validTokens: new Set(),
    authCalls: [],
    searchCalls: [],
    searchResponse: {
      results: [
        { id: "t1", title: "Lover", artist: { name: "Diljit Dosanjh" }, album: { title: "MoonChild Era" }, durationMs: 182000, format: "FLAC", bitDepth: 24, sampleRate: 96000 },
        { id: "t2", title: "Excuses", artists: [{ name: "AP Dhillon" }, { name: "Gurinder Gill" }], duration: 176 },
      ],
    },
    searchDelayMs: 0,
    rejectNextMediaRequests: 0,
    jobs: new Map(),
    jobCreateBodies: [],
    pollsUntilDone: 2,
    failNextPolls: 0,
    hangNextPolls: 0,
    activeJobs: 0,
    peakActiveJobs: 0,
    signedUrlFor: (trackId) =>
      `${base}/cdn/${trackId}.flac?X-Amz-Date=20991231T000000Z&X-Amz-Expires=3600&sig=good`,
    cdnFiles: new Map(),
    cdnRequests: [],
    validSignatures: new Set(["good"]),
    cdnAcceptRanges: true,
    cdnSlowStreamMs: 0,
    cdnClosedEarly: 0,
    ...overrides,
  };

  const mediaAuthorized = (req: IncomingMessage): boolean => {
    if (state.rejectNextMediaRequests > 0) {
      state.rejectNextMediaRequests--;
      return false;
    }
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    return token !== undefined && state.validTokens.has(token);
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", base);
    const path = url.pathname;
    try {
      // --------------------------------------------------- supabase ---
      if (path === "/auth/v1/token" && req.method === "POST") {
        const grant = url.searchParams.get("grant_type") ?? "";
        const body = await readBody(req);
        state.authCalls.push({ grant, body, apikey: req.headers.apikey as string | undefined });
        if (req.headers.apikey !== "anon-key") return json(res, 401, { msg: "Invalid API key" });
        if (grant === "password" && (body.email !== "me@example.com" || body.password !== "pw")) {
          return json(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials" });
        }
        if (grant === "refresh_token" && !String(body.refresh_token).startsWith("rt-")) {
          return json(res, 400, { error: "invalid_grant", error_description: "Invalid Refresh Token" });
        }
        state.issued++;
        const token = `at-${state.issued}`;
        state.validTokens.add(token);
        return json(res, 200, {
          access_token: token,
          token_type: "bearer",
          expires_in: state.tokenTtlSec,
          refresh_token: `rt-${state.issued}`,
        });
      }

      // ------------------------------------------------------ media ---
      if (path.startsWith("/api/")) {
        if (!mediaAuthorized(req)) return json(res, 401, { error: "jwt expired" });

        if (path === "/api/search" && req.method === "GET") {
          state.searchCalls.push({ url, auth: req.headers.authorization });
          if (state.searchDelayMs) await new Promise((r) => setTimeout(r, state.searchDelayMs));
          return json(res, 200, state.searchResponse);
        }

        if (path === "/api/download" && req.method === "POST") {
          const body = await readBody(req);
          state.jobCreateBodies.push(body);
          const trackId = String(body.trackId ?? "");
          if (trackId === "missing") return json(res, 404, { error: "no such track" });
          const jobId = `job-${state.jobs.size + 1}`;
          state.jobs.set(jobId, { trackId, polls: 0 });
          state.activeJobs++;
          state.peakActiveJobs = Math.max(state.peakActiveJobs, state.activeJobs);
          const custom = state.jobCreateResponse?.(trackId, jobId);
          if (custom) {
            state.activeJobs--;
            return json(res, 200, custom);
          }
          return json(res, 202, { jobId, status: "queued" });
        }

        const jobMatch = path.match(/^\/api\/jobs\/([^/]+)$/);
        if (jobMatch && req.method === "GET") {
          if (state.hangNextPolls > 0) {
            state.hangNextPolls--;
            return; // never answer
          }
          if (state.failNextPolls > 0) {
            state.failNextPolls--;
            return json(res, 500, { error: "boom" });
          }
          const jobId = decodeURIComponent(jobMatch[1] as string);
          const job = state.jobs.get(jobId);
          if (!job) return json(res, 404, { error: "unknown job" });
          job.polls++;
          const override = state.jobStatusOverride?.(job, jobId);
          if (override) return json(res, 200, override);
          if (job.polls >= state.pollsUntilDone) {
            state.activeJobs--;
            return json(res, 200, { jobId, status: "completed", progress: 100, url: state.signedUrlFor(job.trackId) });
          }
          return json(res, 200, { jobId, status: "processing", stage: "uploading", progress: Math.round((job.polls / state.pollsUntilDone) * 100) });
        }

        const trackMatch = path.match(/^\/api\/tracks\/([^/]+)$/);
        if (trackMatch) {
          const id = decodeURIComponent(trackMatch[1] as string);
          if (id === "t1") return json(res, 200, { track: { id: "t1", title: "Lover", artist: "Diljit Dosanjh" } });
          return json(res, 404, { error: "not found" });
        }
        return json(res, 404, { error: "no route" });
      }

      // -------------------------------------------------------- cdn ---
      if (path.startsWith("/cdn/")) {
        const range = req.headers.range;
        state.cdnRequests.push({ path, range, method: req.method ?? "GET", auth: req.headers.authorization });
        const sig = url.searchParams.get("sig");
        if (!sig || !state.validSignatures.has(sig)) {
          res.writeHead(403, { "content-type": "application/xml" });
          return res.end("<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>");
        }
        const name = path.slice("/cdn/".length);
        const file = state.cdnFiles.get(name);
        if (!file) {
          res.writeHead(404);
          return res.end();
        }
        const size = file.body.length;
        const headers: Record<string, string | number> = {
          "content-type": file.type,
          etag: `"${name}-${size}"`,
          "last-modified": "Tue, 01 Jan 2030 00:00:00 GMT",
        };
        if (state.cdnAcceptRanges) headers["accept-ranges"] = "bytes";
        const r = state.cdnAcceptRanges ? parseRange(range, size) : undefined;
        if (r === null) {
          res.writeHead(416, { ...headers, "content-range": `bytes */${size}` });
          return res.end();
        }
        const slice = r ? file.body.subarray(r.start, r.end + 1) : file.body;
        res.writeHead(r ? 206 : 200, {
          ...headers,
          "content-length": slice.length,
          ...(r ? { "content-range": `bytes ${r.start}-${r.end}/${size}` } : {}),
        });
        if (state.cdnSlowStreamMs > 0) {
          res.on("close", () => {
            if (!res.writableFinished) state.cdnClosedEarly++;
          });
          for (let i = 0; i < slice.length && !res.destroyed; i += 1024) {
            res.write(slice.subarray(i, i + 1024));
            await new Promise((resolve) => setTimeout(resolve, state.cdnSlowStreamMs));
          }
          return res.end();
        }
        return res.end(slice);
      }

      json(res, 404, { error: "unknown path" });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Deterministic pseudo-random bytes so Range slices are verifiable. */
export function fakeAudio(size: number, seed = 7): Buffer {
  const b = Buffer.alloc(size);
  let s = seed;
  for (let i = 0; i < size; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    b[i] = s & 0xff;
  }
  b.write("fLaC", 0, "ascii");
  return b;
}
