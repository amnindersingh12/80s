/**
 * Small async cache abstraction so the same code works with the in-memory
 * store (default) or Redis when `REDIS_URL` is configured.
 */
export interface CacheStore {
  readonly kind: "memory" | "redis";
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  delete(key: string): Promise<void>;
  close(): Promise<void>;
}

interface Entry {
  value: unknown;
  expiresAt: number;
}

/** TTL + LRU bounded map. Reads refresh recency; expired entries are lazily purged. */
export class MemoryCache implements CacheStore {
  readonly kind = "memory" as const;
  private readonly map = new Map<string, Entry>();

  constructor(
    private readonly maxEntries = 5_000,
    private readonly now: () => number = Date.now,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return structuredClone(entry.value) as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    this.map.delete(key);
    this.map.set(key, { value: structuredClone(value), expiresAt: this.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }

  async close(): Promise<void> {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** Minimal surface of ioredis we rely on (keeps the dependency swappable in tests). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "PX", ttl: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  quit(): Promise<unknown>;
}

export class RedisCache implements CacheStore {
  readonly kind = "redis" as const;

  constructor(
    private readonly client: RedisLike,
    private readonly prefix = "80s:",
    private readonly onError: (err: unknown) => void = () => undefined,
  ) {}

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.client.get(this.prefix + key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    } catch (err) {
      // A cache outage must never break playback: treat it as a miss.
      this.onError(err);
      return undefined;
    }
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (ttlMs <= 0) return;
    try {
      await this.client.set(this.prefix + key, JSON.stringify(value), "PX", Math.ceil(ttlMs));
    } catch (err) {
      this.onError(err);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.del(this.prefix + key);
    } catch (err) {
      this.onError(err);
    }
  }

  async close(): Promise<void> {
    await this.client.quit().catch(() => undefined);
  }
}

export async function createCache(options: {
  redisUrl?: string;
  prefix?: string;
  onError?: (err: unknown) => void;
}): Promise<CacheStore> {
  if (!options.redisUrl) return new MemoryCache();
  const { Redis } = await import("ioredis");
  const client = new Redis(options.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5_000,
  });
  client.on("error", (err) => options.onError?.(err));
  await client.connect();
  return new RedisCache(client as unknown as RedisLike, options.prefix, options.onError);
}
