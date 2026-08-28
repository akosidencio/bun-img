import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { memoryCache } from "../../src/cache/memory.ts";
import { diskCache } from "../../src/cache/disk.ts";
import { nullCache, tieredCache } from "../../src/cache/tiered.ts";
import { isCacheableFailure, negativeCache } from "../../src/cache/negative.ts";
import { formatSize, parseSize } from "../../src/cache/size.ts";
import { ImageError } from "../../src/errors.ts";
import type { CachedImage } from "../../src/cache/types.ts";

const entry = (bytes: number, over: Partial<CachedImage> = {}): CachedImage => ({
  bytes: new Uint8Array(bytes).fill(7),
  width: 100,
  height: 50,
  format: "webp",
  etag: '"bimg_test"',
  storedAt: Date.now(),
  ...over,
});

let scratch: string;

beforeAll(() => {
  scratch = join(tmpdir(), `bun-img-cache-${Bun.randomUUIDv7()}`);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("parseSize", () => {
  test("parses decimal units", () => {
    expect(parseSize("1KB")).toBe(1_000);
    expect(parseSize("256MB")).toBe(256_000_000);
    expect(parseSize("2GB")).toBe(2_000_000_000);
  });

  test("parses binary units distinctly — MB is not MiB", () => {
    // Treating them as equal would make a stated 2 GB budget 7% over the
    // container limit it was chosen to fit under.
    expect(parseSize("1MiB")).toBe(1_048_576);
    expect(parseSize("1MB")).toBe(1_000_000);
    expect(parseSize("1GiB")).not.toBe(parseSize("1GB"));
  });

  test("accepts raw numbers, decimals, spacing and case", () => {
    expect(parseSize(4096)).toBe(4096);
    expect(parseSize("1.5KB")).toBe(1500);
    expect(parseSize(" 2 gb ")).toBe(2_000_000_000);
    expect(parseSize("512")).toBe(512);
  });

  test("rejects nonsense", () => {
    for (const bad of ["", "abc", "10 parsecs", "-5MB", "MB"]) {
      expect(() => parseSize(bad)).toThrow(TypeError);
    }
    expect(() => parseSize(-1)).toThrow(TypeError);
  });

  test("formatSize is readable", () => {
    expect(formatSize(512)).toBe("512B");
    expect(formatSize(2_500_000)).toBe("2.5MB");
  });
});

describe("memoryCache", () => {
  test("stores and returns entries", async () => {
    const cache = memoryCache();
    await cache.set("a", entry(100));
    const hit = await cache.get("a");
    expect(hit?.bytes.byteLength).toBe(100);
    expect(hit?.format).toBe("webp");
  });

  test("misses cleanly", async () => {
    expect(await memoryCache().get("nope")).toBeNull();
  });

  test("accounts in bytes, not entries", async () => {
    // The whole point: 5,000 thumbnails and 5,000 4K stills are not the same
    // amount of memory, and an entry counter cannot tell them apart.
    const cache = memoryCache({ maxSize: 10_000 });
    await cache.set("small", entry(100));
    await cache.set("large", entry(5_000));
    const size = await cache.size();
    expect(size.bytes).toBeGreaterThan(5_100);
    expect(size.entries).toBe(2);
  });

  test("evicts least-recently-used once over budget", async () => {
    const cache = memoryCache({ maxSize: 3_000 });
    await cache.set("a", entry(1_000));
    await cache.set("b", entry(1_000));
    await cache.get("a"); // refresh a
    await cache.set("c", entry(1_000)); // pushes over; b is coldest

    expect(await cache.get("a")).not.toBeNull();
    expect(await cache.get("b")).toBeNull();
    expect(await cache.get("c")).not.toBeNull();
  });

  test("never exceeds its byte budget under a flood", async () => {
    const cache = memoryCache({ maxSize: 50_000 });
    for (let i = 0; i < 500; i++) await cache.set(`k${i}`, entry(1_000));
    expect((await cache.size()).bytes).toBeLessThanOrEqual(50_000);
  });

  test("honours maxEntries as a secondary ceiling", async () => {
    const cache = memoryCache({ maxSize: "1GB", maxEntries: 10 });
    for (let i = 0; i < 50; i++) await cache.set(`k${i}`, entry(10));
    expect((await cache.size()).entries).toBe(10);
  });

  test("refuses an entry larger than the whole budget", async () => {
    // Admitting it would evict everything, then be evicted on the next write.
    const cache = memoryCache({ maxSize: 1_000 });
    await cache.set("small", entry(100));
    await cache.set("huge", entry(50_000));
    expect(await cache.get("huge")).toBeNull();
    expect(await cache.get("small")).not.toBeNull();
  });

  test("overwriting a key does not double-count its bytes", async () => {
    const cache = memoryCache({ maxSize: 100_000 });
    await cache.set("a", entry(1_000));
    const first = (await cache.size()).bytes;
    await cache.set("a", entry(1_000));
    expect((await cache.size()).bytes).toBe(first);
    expect((await cache.size()).entries).toBe(1);
  });

  test("delete and clear release bytes", async () => {
    const cache = memoryCache();
    await cache.set("a", entry(1_000));
    await cache.delete("a");
    expect((await cache.size()).bytes).toBe(0);

    await cache.set("b", entry(1_000));
    await cache.clear();
    expect(await cache.size()).toEqual({ bytes: 0, entries: 0 });
  });
});

describe("diskCache", () => {
  const dirFor = (name: string) => join(scratch, name);

  test("round-trips an entry with all its metadata", async () => {
    const cache = diskCache({ directory: dirFor("roundtrip") });
    const original = entry(500, { width: 321, height: 123, format: "png", etag: '"x"' });
    await cache.set("bimg_abc123", original);

    const hit = await cache.get("bimg_abc123");
    expect(hit).not.toBeNull();
    expect(hit!.width).toBe(321);
    expect(hit!.height).toBe(123);
    expect(hit!.format).toBe("png");
    expect(hit!.etag).toBe('"x"');
    expect(hit!.bytes.byteLength).toBe(500);
    expect([...hit!.bytes.slice(0, 4)]).toEqual([7, 7, 7, 7]);
  });

  test("carries the source version through", async () => {
    const cache = diskCache({ directory: dirFor("version") });
    await cache.set("bimg_v", entry(10, { sourceVersion: "etag-1" }));
    expect((await cache.get("bimg_v"))?.sourceVersion).toBe("etag-1");
  });

  test("survives a restart", async () => {
    const dir = dirFor("restart");
    const first = diskCache({ directory: dir });
    await first.set("bimg_persist", entry(400));

    const second = diskCache({ directory: dir });
    const hit = await second.get("bimg_persist");
    expect(hit?.bytes.byteLength).toBe(400);
    expect((await second.size()).entries).toBe(1);
  });

  test("treats a truncated entry as a miss and removes it", async () => {
    // rename should make this impossible; the check exists so that if it ever
    // does happen, a half-written file is never served as an image.
    const dir = dirFor("truncated");
    const cache = diskCache({ directory: dir });
    await cache.set("bimg_trunc", entry(1_000));
    await cache.size(); // force the index

    const path = join(dir, "tr", "bimg_trunc");
    const raw = await Bun.file(path).bytes();
    await Bun.write(path, raw.subarray(0, raw.byteLength - 200));

    expect(await cache.get("bimg_trunc")).toBeNull();
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("treats a garbage file as a miss", async () => {
    const dir = dirFor("garbage");
    await Bun.write(join(dir, "ga", "bimg_garbage"), "not an entry at all");
    const cache = diskCache({ directory: dir });
    expect(await cache.get("bimg_garbage")).toBeNull();
  });

  test("sweeps temp files left behind by a crash", async () => {
    // What a SIGKILL mid-write leaves: a temp file and no entry.
    const dir = dirFor("crash");
    await Bun.write(join(dir, ".tmp", "bimg_orphan.01234"), new Uint8Array(9_000));
    await Bun.write(join(dir, ".tmp", "bimg_orphan2.56789"), new Uint8Array(9_000));

    const cache = diskCache({ directory: dir });
    const size = await cache.size();
    expect(size.entries).toBe(0);
    expect(size.bytes).toBe(0);
    expect(await Bun.file(join(dir, ".tmp", "bimg_orphan.01234")).exists()).toBe(false);
  });

  test("a crash mid-write leaves no partial entry", async () => {
    // Simulated by writing a temp file and never renaming it — the exact state
    // a killed process leaves behind.
    const dir = dirFor("nopartial");
    const cache = diskCache({ directory: dir });
    await cache.set("bimg_good", entry(100));
    await Bun.write(join(dir, ".tmp", "bimg_bad.xyz"), new Uint8Array(500));

    const reopened = diskCache({ directory: dir });
    expect(await reopened.get("bimg_good")).not.toBeNull();
    expect(await reopened.get("bimg_bad")).toBeNull();
    expect((await reopened.size()).entries).toBe(1);
  });

  test("stays within maxSize under a flood of distinct keys", async () => {
    const cache = diskCache({ directory: dirFor("flood"), maxSize: 50_000 });
    for (let i = 0; i < 200; i++) await cache.set(`bimg_${i.toString(16).padStart(8, "0")}`, entry(1_000));
    const size = await cache.size();
    expect(size.bytes).toBeLessThanOrEqual(50_000);
  });

  test("refuses an entry larger than the budget", async () => {
    const cache = diskCache({ directory: dirFor("toobig"), maxSize: 1_000 });
    await cache.set("bimg_huge", entry(50_000));
    expect(await cache.get("bimg_huge")).toBeNull();
  });

  test("shards entries so no directory grows unbounded", async () => {
    const dir = dirFor("shard");
    const cache = diskCache({ directory: dir });
    await cache.set("bimg_aa1", entry(10));
    await cache.set("bimg_bb2", entry(10));
    expect(await Bun.file(join(dir, "aa", "bimg_aa1")).exists()).toBe(true);
    expect(await Bun.file(join(dir, "bb", "bimg_bb2")).exists()).toBe(true);
  });

  test("delete and clear work", async () => {
    const cache = diskCache({ directory: dirFor("del") });
    await cache.set("bimg_d1", entry(100));
    await cache.delete("bimg_d1");
    expect(await cache.get("bimg_d1")).toBeNull();

    await cache.set("bimg_d2", entry(100));
    await cache.clear();
    expect(await cache.size()).toEqual({ bytes: 0, entries: 0 });
  });
});

describe("tieredCache", () => {
  test("promotes a disk hit into memory", async () => {
    const memory = memoryCache();
    const disk = diskCache({ directory: join(scratch, "tier") });
    await disk.set("bimg_t", entry(300));

    const tiered = tieredCache([memory, disk]);
    expect(await tiered.get("bimg_t")).not.toBeNull();
    // Now served without touching the filesystem.
    expect(await memory.get("bimg_t")).not.toBeNull();
  });

  test("writes to every tier", async () => {
    const memory = memoryCache();
    const disk = diskCache({ directory: join(scratch, "tier2") });
    await tieredCache([memory, disk]).set("bimg_w", entry(100));
    expect(await memory.get("bimg_w")).not.toBeNull();
    expect(await disk.get("bimg_w")).not.toBeNull();
  });

  test("a failing tier does not lose the write for the others", async () => {
    // A full disk should degrade to memory-only, not to an error.
    const memory = memoryCache();
    const broken = {
      ...nullCache(),
      name: "broken",
      async set() {
        throw new Error("disk full");
      },
    };
    await tieredCache([memory, broken]).set("bimg_r", entry(100));
    expect(await memory.get("bimg_r")).not.toBeNull();
  });

  test("nullCache stores nothing", async () => {
    const cache = nullCache();
    await cache.set("a", entry(100));
    expect(await cache.get("a")).toBeNull();
  });
});

describe("negativeCache", () => {
  const notFound = new ImageError("SOURCE_NOT_FOUND", 404, "source not found");

  test("remembers a cacheable failure", () => {
    const cache = negativeCache();
    cache.set("k", notFound);
    expect(cache.get("k")?.code).toBe("SOURCE_NOT_FOUND");
    expect(cache.get("k")?.status).toBe(404);
  });

  test("expires after the TTL", async () => {
    const cache = negativeCache({ ttl: 30 });
    cache.set("k", notFound);
    expect(cache.get("k")).not.toBeNull();
    await Bun.sleep(50);
    expect(cache.get("k")).toBeNull();
  });

  test("does not remember our own load problems", () => {
    // QUEUE_FULL and timeouts describe us, not the source. Caching them would
    // turn a brief saturation spike into a minute of failure for good content.
    const cache = negativeCache();
    for (const code of ["QUEUE_FULL", "FETCH_TIMEOUT", "TRANSFORM_TIMEOUT", "INTERNAL_ERROR"] as const) {
      cache.set("k", new ImageError(code, 503, "transient"));
      expect(cache.get("k")).toBeNull();
    }
  });

  test("isCacheableFailure agrees", () => {
    expect(isCacheableFailure(notFound)).toBe(true);
    expect(isCacheableFailure(new ImageError("QUEUE_FULL", 503, "x"))).toBe(false);
    expect(isCacheableFailure(new Error("plain"))).toBe(false);
    expect(isCacheableFailure(null)).toBe(false);
  });

  test("bounds its own size", () => {
    const cache = negativeCache({ maxEntries: 10 });
    for (let i = 0; i < 100; i++) cache.set(`k${i}`, notFound);
    expect(cache.size).toBeLessThanOrEqual(10);
  });

  test("delete and clear work", () => {
    const cache = negativeCache();
    cache.set("k", notFound);
    cache.delete("k");
    expect(cache.get("k")).toBeNull();

    cache.set("k2", notFound);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
