import type { PrepareStatus } from "../../../shared/api.js";
import { toAppError } from "../errors.js";
import type { ProviderChain, ResolvedStream } from "../providers/chain.js";

interface Entry {
  status: PrepareStatus;
  promise?: Promise<ResolvedStream>;
  touchedAt: number;
}

/**
 * Tracks "is this track's stream ready yet?" so the UI can show a preparing
 * indicator (stage / progress / elapsed) while the upstream job runs, and so
 * the stream route and the prepare route share a single resolution.
 */
export class PrepareTracker {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly chain: ProviderChain,
    private readonly options: { retainMs?: number; maxEntries?: number; now?: () => number } = {},
  ) {}

  private get now(): number {
    return (this.options.now ?? Date.now)();
  }

  status(id: string): PrepareStatus {
    const e = this.entries.get(id);
    if (!e) return { id, state: "idle" };
    return this.snapshot(e);
  }

  /** Kick off resolution in the background and return the current status. */
  start(id: string): PrepareStatus {
    this.ensure(id).catch(() => undefined);
    return this.status(id);
  }

  /** Resolve (or join the in-flight resolution of) a track's stream source. */
  ensure(id: string): Promise<ResolvedStream> {
    this.sweep();
    const existing = this.entries.get(id);
    if (existing?.promise) return existing.promise;

    const startedAt = this.now;
    const entry: Entry = { status: { id, state: "preparing", startedAt, stage: "queued" }, touchedAt: startedAt };
    this.entries.set(id, entry);

    entry.promise = this.chain
      .resolveStream(id, {
        onProgress: (p) => {
          if (entry.status.state !== "preparing") return;
          if (p.stage !== undefined) entry.status.stage = p.stage;
          if (p.progress !== undefined) entry.status.progress = p.progress;
        },
      })
      .then(
        (resolved) => {
          entry.status = {
            id,
            state: "ready",
            startedAt,
            elapsedMs: this.now - startedAt,
            servedBy: resolved.servedBy.name,
            fallback: resolved.fallback,
          };
          entry.promise = undefined;
          entry.touchedAt = this.now;
          return resolved;
        },
        (err: unknown) => {
          const appErr = toAppError(err);
          entry.status = { id, state: "error", startedAt, elapsedMs: this.now - startedAt, error: appErr.toBody().error };
          entry.promise = undefined;
          entry.touchedAt = this.now;
          throw appErr;
        },
      );
    return entry.promise;
  }

  private snapshot(e: Entry): PrepareStatus {
    const s = { ...e.status };
    if (s.state === "preparing" && s.startedAt !== undefined) s.elapsedMs = this.now - s.startedAt;
    return s;
  }

  private sweep(): void {
    const retain = this.options.retainMs ?? 10 * 60_000;
    const max = this.options.maxEntries ?? 2_000;
    const cutoff = this.now - retain;
    for (const [id, e] of this.entries) {
      if (!e.promise && e.touchedAt < cutoff) this.entries.delete(id);
    }
    while (this.entries.size > max) {
      const oldest = [...this.entries.entries()].find(([, e]) => !e.promise);
      if (!oldest) break;
      this.entries.delete(oldest[0]);
    }
  }
}
