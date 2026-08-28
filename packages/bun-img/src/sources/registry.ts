/**
 * Resolver dispatch, plus the bounded per-source metadata cache.
 *
 * Dimensions and placeholders derive from the *source*, not from any transform,
 * so they are cached per source identity and shared across every width, quality
 * and format of that image. A placeholder costs a full decode — measured ~188 ms
 * on a 4K JPEG — so this is not an optimization, it is the difference between
 * usable and not.
 */
import { ImageError } from "../errors.ts";
import type { SourceIdentity, SourceInfo } from "../types.ts";
import type { ResolveContext, ResolvedSource, SourceResolver } from "./types.ts";

export interface SourceRegistryOptions {
  resolvers: readonly SourceResolver[];
  /** Entries in the source-metadata cache. Bounded to keep memory flat. */
  maxInfoEntries?: number;
}

export interface SourceRegistry {
  readonly resolvers: readonly SourceResolver[];
  resolve(source: string, context: ResolveContext): Promise<ResolvedSource>;
  /** Memoize per source version; recomputed when the version changes. */
  info(key: string, compute: () => Promise<SourceInfo>): Promise<SourceInfo>;
  /**
   * Read a cached `SourceInfo` without computing one.
   *
   * The cache-hit path needs the source's *format* to negotiate an output
   * format, but must not open the source to get it. After the first request for
   * a source, this supplies it for free — which is what lets every later
   * transform of that image be answered from cache without any I/O.
   */
  peekInfo(key: string): Promise<SourceInfo | null>;
  /** Identity for a source reference, without reading it. Null when unavailable. */
  identify(source: string, context: ResolveContext): Promise<SourceIdentity | null>;
  placeholder(key: string, compute: () => Promise<string>): Promise<string>;
  clear(): void;
}

/** Insertion-ordered LRU: re-inserting on read moves an entry to the back. */
class Lru<T> {
  readonly #map = new Map<string, T>();
  constructor(private readonly limit: number) {}

  get(key: string): T | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.limit) {
      const oldest = this.#map.keys().next().value;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.#map.delete(key);
  }

  clear(): void {
    this.#map.clear();
  }

  get size(): number {
    return this.#map.size;
  }
}

export function createSourceRegistry(options: SourceRegistryOptions): SourceRegistry {
  const resolvers = [...options.resolvers];
  const limit = options.maxInfoEntries ?? 1000;

  // Promises are cached, not values, so concurrent requests for a cold source
  // share one decode instead of racing.
  const infoCache = new Lru<Promise<SourceInfo>>(limit);
  const placeholderCache = new Lru<Promise<string>>(limit);

  async function memo<T>(cache: Lru<Promise<T>>, key: string, compute: () => Promise<T>) {
    const hit = cache.get(key);
    if (hit) return await hit;
    const pending = compute();
    cache.set(key, pending);
    try {
      return await pending;
    } catch (err) {
      // Evict on failure. Caching a rejection here would pin a transient decode
      // error for the life of the process; negative caching belongs in Phase 3,
      // where it can have a TTL.
      cache.delete(key);
      throw err;
    }
  }

  return {
    resolvers,

    async resolve(source: string, context: ResolveContext): Promise<ResolvedSource> {
      if (source.length === 0) {
        throw new ImageError("INVALID_REQUEST", 400, "empty source");
      }
      for (const resolver of resolvers) {
        if (resolver.supports(source)) return await resolver.resolve(source, context);
      }
      throw new ImageError("SOURCE_NOT_ALLOWED", 403, "source not allowed");
    },

    info: (key, compute) => memo(infoCache, key, compute),
    placeholder: (key, compute) => memo(placeholderCache, key, compute),

    async peekInfo(key: string): Promise<SourceInfo | null> {
      const pending = infoCache.get(key);
      if (!pending) return null;
      // A stored rejection must read as "not known", not as a thrown error:
      // this is a peek, and the caller has a slow path.
      return await pending.catch(() => null);
    },

    async identify(source: string, context: ResolveContext): Promise<SourceIdentity | null> {
      for (const resolver of resolvers) {
        if (!resolver.supports(source)) continue;
        if (!resolver.identify) return null;
        return await resolver.identify(source, context);
      }
      // Nothing claims it. Stay silent here and let resolve() produce the
      // refusal, so there is one place that decides what is allowed.
      return null;
    },

    clear() {
      infoCache.clear();
      placeholderCache.clear();
    },
  };
}
