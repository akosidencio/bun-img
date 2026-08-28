/**
 * In-process LRU, accounted in **bytes** rather than entries.
 *
 * Counting entries is the wrong unit for images: 5,000 thumbnails and 5,000
 * 4K stills differ by three orders of magnitude in memory but look identical to
 * an entry counter. A byte budget is the one an operator can reason about
 * against a container limit.
 */
import type { CachedImage, ImageCache } from "./types.ts";
import { parseSize } from "./size.ts";

export interface MemoryCacheOptions {
  /** `"256MB"`, `"1GB"`, or a raw byte count. */
  maxSize?: string | number;
  /** Secondary ceiling, to bound bookkeeping when entries are tiny. */
  maxEntries?: number;
}

/** Rough per-entry overhead: key string, object headers, map slot. */
const ENTRY_OVERHEAD = 256;

export function memoryCache(options: MemoryCacheOptions = {}): ImageCache {
  const maxSize = parseSize(options.maxSize ?? "256MB");
  const maxEntries = options.maxEntries ?? 5000;

  // Map iteration order is insertion order, so re-inserting on read gives LRU
  // ordering without a second data structure.
  const entries = new Map<string, CachedImage>();
  let bytes = 0;

  const weigh = (image: CachedImage) => image.bytes.byteLength + ENTRY_OVERHEAD;

  function evictUntilFits(): void {
    while ((bytes > maxSize || entries.size > maxEntries) && entries.size > 0) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      const victim = entries.get(oldest);
      entries.delete(oldest);
      if (victim) bytes -= weigh(victim);
    }
  }

  return {
    name: "memory",

    async get(key: string): Promise<CachedImage | null> {
      const hit = entries.get(key);
      if (!hit) return null;
      // Refresh recency.
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },

    async set(key: string, image: CachedImage): Promise<void> {
      const weight = weigh(image);

      // An entry larger than the whole budget is not stored at all: admitting
      // it would evict everything else and then be evicted itself on the next
      // write, so it only ever costs.
      if (weight > maxSize) return;

      const existing = entries.get(key);
      if (existing) {
        entries.delete(key);
        bytes -= weigh(existing);
      }

      entries.set(key, image);
      bytes += weight;
      evictUntilFits();
    },

    async delete(key: string): Promise<void> {
      const victim = entries.get(key);
      if (!victim) return;
      entries.delete(key);
      bytes -= weigh(victim);
    },

    async clear(): Promise<void> {
      entries.clear();
      bytes = 0;
    },

    async size(): Promise<{ bytes: number; entries: number }> {
      return { bytes, entries: entries.size };
    },
  };
}
