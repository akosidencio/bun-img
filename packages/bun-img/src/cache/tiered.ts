/**
 * Memory in front of disk.
 *
 * A disk hit still costs a read and a decode of the entry header; a memory hit
 * costs a map lookup. Promoting disk hits into memory means a working set that
 * fits in RAM stops touching the filesystem after the first request each.
 *
 * Writes go to both tiers. Memory alone would lose everything on restart; disk
 * alone would pay filesystem cost for the hottest images.
 */
import type { CachedImage, ImageCache } from "./types.ts";

export function tieredCache(tiers: readonly ImageCache[]): ImageCache {
  const layers = [...tiers];

  return {
    name: layers.map((t) => t.name).join("+") || "none",

    async get(key: string): Promise<CachedImage | null> {
      for (let i = 0; i < layers.length; i++) {
        const hit = await layers[i]!.get(key);
        if (!hit) continue;

        // Promote into every faster tier that missed.
        for (let j = 0; j < i; j++) {
          await layers[j]!.set(key, hit).catch(() => {});
        }
        return hit;
      }
      return null;
    },

    async set(key: string, image: CachedImage): Promise<void> {
      // A failing tier must not lose the write for the others — a full disk
      // should degrade to memory-only, not to an error.
      await Promise.all(layers.map((tier) => tier.set(key, image).catch(() => {})));
    },

    async delete(key: string): Promise<void> {
      await Promise.all(layers.map((tier) => tier.delete(key).catch(() => {})));
    },

    async clear(): Promise<void> {
      await Promise.all(layers.map((tier) => tier.clear().catch(() => {})));
    },

    async size(): Promise<{ bytes: number; entries: number }> {
      const sizes = await Promise.all(layers.map((tier) => tier.size()));
      return {
        bytes: sizes.reduce((total, s) => total + s.bytes, 0),
        entries: sizes.reduce((total, s) => total + s.entries, 0),
      };
    },
  };
}

/** A cache that stores nothing. The default, so caching stays opt-in. */
export function nullCache(): ImageCache {
  return {
    name: "null",
    async get() {
      return null;
    },
    async set() {},
    async delete() {},
    async clear() {},
    async size() {
      return { bytes: 0, entries: 0 };
    },
  };
}
