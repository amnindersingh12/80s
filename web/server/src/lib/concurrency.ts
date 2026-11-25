import { AppError } from "../errors.js";

/** FIFO mutual-exclusion lock for async critical sections. */
export class AsyncLock {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const previous = this.tail;
    this.tail = previous.then(() => next);
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: unknown) => void;
  cleanup: () => void;
}

/**
 * Counting semaphore. `acquire` resolves with a one-shot release function and
 * can be bounded by a wait timeout and/or an AbortSignal so queued work never
 * hangs forever behind stalled jobs.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];
  /** Highest concurrency ever observed; handy for tests and health output. */
  peak = 0;

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Semaphore limit must be >= 1");
  }

  get inUse(): number {
    return this.active;
  }

  get pending(): number {
    return this.waiters.length;
  }

  acquire(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<() => void> {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    if (this.active < this.limit) return Promise.resolve(this.grant());

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const onAbort = () => {
        remove();
        reject(options.signal?.reason);
      };
      const remove = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        waiter.cleanup();
      };
      const waiter: Waiter = {
        resolve,
        reject,
        cleanup: () => {
          if (timer) clearTimeout(timer);
          options.signal?.removeEventListener("abort", onAbort);
        },
      };
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          remove();
          reject(
            new AppError(
              "PROVIDER_BUSY",
              `All ${this.limit} job slots are busy; gave up after ${options.timeoutMs} ms`,
            ),
          );
        }, options.timeoutMs);
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  async use<T>(fn: () => Promise<T>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T> {
    const release = await this.acquire(options);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private grant(): () => void {
    this.active++;
    this.peak = Math.max(this.peak, this.active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      const next = this.waiters.shift();
      if (next) {
        next.cleanup();
        next.resolve(this.grant());
      }
    };
  }
}

/** Coalesces concurrent calls with the same key into one in-flight promise. */
export class SingleFlight<T> {
  private readonly inflight = new Map<string, Promise<T>>();

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const promise = (async () => {
      try {
        return await fn();
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, promise);
    return promise;
  }

  has(key: string): boolean {
    return this.inflight.has(key);
  }
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<I, O>(
  items: readonly I[],
  limit: number,
  fn: (item: I, index: number) => Promise<O>,
): Promise<O[]> {
  const results = new Array<O>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as I, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Serialises calls so consecutive starts are at least `intervalMs` apart. */
export class IntervalLimiter {
  private chain: Promise<void> = Promise.resolve();
  private last = 0;

  constructor(private readonly intervalMs: number, private readonly now: () => number = Date.now) {}

  schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.last + this.intervalMs - this.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = this.now();
    });
    this.chain = run.catch(() => undefined);
    return run.then(fn);
  }
}
