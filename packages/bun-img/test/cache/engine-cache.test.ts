import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createImageEngine } from "../../src/engine.ts";
import { memoryCache } from "../../src/cache/memory.ts";
import type { SourceResolver } from "../../src/sources/types.ts";
import { expectCode, makeImage } from "../helpers.ts";
import { ImageError } from "../../src/errors.ts";

let root: string;
let scratch: string;

beforeAll(async () => {
  scratch = join(tmpdir(), `bun-img-engcache-${Bun.randomUUIDv7()}`);
  root = join(scratch, "public");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "hero.png"), await makeImage(1200, 600, "png"));
  await writeFile(join(root, "other.png"), await makeImage(800, 800, "png"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/** Counts how many times the source bytes are actually read. */
function countingResolver(bytes: Uint8Array, version = "v1") {
  const state = { reads: 0, identifies: 0 };
  const resolver: SourceResolver = {
    name: "counting",
    supports: () => true,
    async identify() {
      state.identifies++;
      return { id: "counted", version };
    },
    async resolve() {
      state.reads++;
      return { data: bytes, identity: { id: "counted", version }, kind: "custom" as const };
    },
  };
  return { resolver, state };
}

describe("cache hit path", () => {
  test("a repeat request is served from cache", async () => {
    const engine = createImageEngine({ local: { root }, cache: { memory: {} } });
    const first = await engine.optimize({ src: "hero.png", transform: { width: 320, format: "webp" } });
    const second = await engine.optimize({ src: "hero.png", transform: { width: 320, format: "webp" } });

    expect(first.cache).toBe("miss");
    expect(second.cache).toBe("hit");
    expect(second.etag).toBe(first.etag);
    expect(second.size).toBe(first.size);
    expect(second.width).toBe(320);
  });

  test("a hit does NOT read the source", async () => {
    // The whole point. A "cache hit" that still fetched and decoded the source
    // would not be a cache at all — it would just move the work around.
    const { resolver, state } = countingResolver(await makeImage(1000, 500, "png"));
    const engine = createImageEngine({ resolvers: [resolver], cache: { memory: {} } });

    await engine.optimize({ src: "x", transform: { width: 320, format: "webp" } });
    expect(state.reads).toBe(1);

    for (let i = 0; i < 5; i++) {
      const out = await engine.optimize({ src: "x", transform: { width: 320, format: "webp" } });
      expect(out.cache).toBe("hit");
    }
    expect(state.reads).toBe(1);
  });

  test("a second transform of the same source also skips the read", async () => {
    // Format comes from the per-source memo populated by the first request, so
    // every later width and format is answerable without I/O.
    const { resolver, state } = countingResolver(await makeImage(1000, 500, "png"));
    const engine = createImageEngine({ resolvers: [resolver], cache: { memory: {} } });

    await engine.optimize({ src: "x", transform: { width: 320, format: "webp" } });
    expect(state.reads).toBe(1);

    // A different width is a genuine miss and must do the work once...
    await engine.optimize({ src: "x", transform: { width: 640, format: "webp" } });
    expect(state.reads).toBe(2);

    // ...but never again.
    const again = await engine.optimize({ src: "x", transform: { width: 640, format: "webp" } });
    expect(again.cache).toBe("hit");
    expect(state.reads).toBe(2);
  });

  test("distinct transforms get distinct entries", async () => {
    const engine = createImageEngine({ local: { root }, cache: { memory: {} } });
    const a = await engine.optimize({ src: "hero.png", transform: { width: 320, format: "webp" } });
    const b = await engine.optimize({ src: "hero.png", transform: { width: 640, format: "webp" } });
    expect(a.key).not.toBe(b.key);
    expect(a.etag).not.toBe(b.etag);
    expect((await engine.cache.size()).entries).toBe(2);
  });

  test("a changed source invalidates the entry", async () => {
    // mtime+size is in the identity, so a rewrite produces a new key rather
    // than serving stale bytes.
    const dir = join(scratch, "invalidate");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "a.png");
    await writeFile(file, await makeImage(400, 400, "png"));

    const engine = createImageEngine({ local: { root: dir }, cache: { memory: {} } });
    const first = await engine.optimize({ src: "a.png", transform: { width: 320, format: "webp" } });
    expect(first.cache).toBe("miss");

    await Bun.sleep(10);
    await writeFile(file, await makeImage(600, 600, "png"));
    engine.sources.clear(); // drop the per-source metadata memo too

    const second = await engine.optimize({ src: "a.png", transform: { width: 320, format: "webp" } });
    expect(second.cache).toBe("miss");
    expect(second.key).not.toBe(first.key);
  });

  test("caching is off unless configured", async () => {
    const engine = createImageEngine({ local: { root } });
    const a = await engine.optimize({ src: "hero.png", transform: { width: 320, format: "webp" } });
    const b = await engine.optimize({ src: "hero.png", transform: { width: 320, format: "webp" } });
    expect(a.cache).toBe("miss");
    expect(b.cache).toBe("miss");
  });

  test("byte inputs are still transformed, and not cached by identity", async () => {
    const engine = createImageEngine({ cache: { memory: {} } });
    const bytes = await makeImage(800, 400, "png");
    const out = await engine.optimize({ source: bytes, transform: { width: 320, format: "webp" } });
    expect(out.width).toBe(320);
  });
});

describe("coalescing through the engine", () => {
  test("100 concurrent identical requests produce exactly one transform", async () => {
    // Phase 3's acceptance criterion, measured at the engine boundary.
    const { resolver, state } = countingResolver(await makeImage(1000, 500, "png"));
    const engine = createImageEngine({
      resolvers: [resolver],
      cache: { memory: {} },
      concurrency: { transforms: 4, maxPending: 512 },
    });

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        engine.optimize({ src: "x", transform: { width: 320, format: "webp" } }),
      ),
    );

    expect(results).toHaveLength(100);
    expect(state.reads).toBe(1);

    const statuses = results.map((r) => r.cache);
    expect(statuses.filter((s) => s === "miss")).toHaveLength(1);
    expect(statuses.filter((s) => s === "coalesced").length).toBeGreaterThan(90);
    // Every caller gets identical bytes.
    expect(new Set(results.map((r) => r.etag)).size).toBe(1);
  }, 30_000);

  test("concurrent requests for different images are not coalesced together", async () => {
    const engine = createImageEngine({
      local: { root },
      cache: { memory: {} },
      concurrency: { transforms: 4, maxPending: 64 },
    });

    const [a, b] = await Promise.all([
      engine.optimize({ src: "hero.png", transform: { width: 320, format: "webp" } }),
      engine.optimize({ src: "other.png", transform: { width: 320, format: "webp" } }),
    ]);

    expect(a.etag).not.toBe(b.etag);
  });
});

describe("concurrency limits", () => {
  test("sheds load with QUEUE_FULL rather than queueing without bound", async () => {
    // Widths must be genuinely distinct *after* quantization, or they coalesce
    // onto one key and never contend for a slot — quantization is doing its job,
    // it just makes an unrealistic load test.
    const widths = Array.from({ length: 40 }, (_, i) => 200 + i * 10);
    const engine = createImageEngine({
      local: { root },
      widths,
      concurrency: { transforms: 1, maxPending: 1 },
    });

    const attempts = widths.map((width) =>
      engine
        .optimize({ src: "hero.png", transform: { width, format: "webp" } })
        .then(() => "ok")
        .catch((e: ImageError) => e.code),
    );

    const outcomes = await Promise.all(attempts);
    expect(outcomes).toContain("QUEUE_FULL");
    expect(outcomes).toContain("ok");
  }, 30_000);

  test("a saturated queue recovers once work drains", async () => {
    const widths = Array.from({ length: 20 }, (_, i) => 200 + i * 10);
    const engine = createImageEngine({
      local: { root },
      widths,
      concurrency: { transforms: 1, maxPending: 1 },
    });

    await Promise.all(
      widths.map((width) =>
        engine.optimize({ src: "hero.png", transform: { width, format: "webp" } }).catch(() => {}),
      ),
    );

    // Nothing is stuck: the semaphore released every slot it handed out.
    expect(engine.semaphore.stats.active).toBe(0);
    expect(engine.semaphore.stats.pending).toBe(0);
    const after = await engine.optimize({ src: "hero.png", transform: { width: 200, format: "webp" } });
    expect(after.width).toBeGreaterThan(0);
  }, 30_000);

  test("exposes semaphore stats", async () => {
    const engine = createImageEngine({ local: { root }, concurrency: { transforms: 3 } });
    expect(engine.semaphore.stats.limit).toBe(3);
    expect(engine.semaphore.stats.active).toBe(0);
  });
});

describe("negative caching", () => {
  test("a failing source is not retried within the TTL", async () => {
    // Otherwise one dead URL on a page turns the endpoint into a load generator
    // pointed at the origin.
    let attempts = 0;
    const failing: SourceResolver = {
      name: "failing",
      supports: () => true,
      async identify() {
        return { id: "gone", version: "v1" };
      },
      async resolve() {
        attempts++;
        throw new ImageError("SOURCE_NOT_FOUND", 404, "source not found");
      },
    };

    const engine = createImageEngine({
      resolvers: [failing],
      cache: { memory: {}, negative: { ttl: 5_000 } },
    });

    for (let i = 0; i < 5; i++) {
      await expectCode(() => engine.optimize({ src: "gone" }), "SOURCE_NOT_FOUND");
    }
    expect(attempts).toBe(1);
  });

  test("the failure is retried after the TTL expires", async () => {
    let attempts = 0;
    const failing: SourceResolver = {
      name: "failing",
      supports: () => true,
      async identify() {
        return { id: "gone2", version: "v1" };
      },
      async resolve() {
        attempts++;
        throw new ImageError("SOURCE_NOT_FOUND", 404, "source not found");
      },
    };

    const engine = createImageEngine({
      resolvers: [failing],
      cache: { memory: {}, negative: { ttl: 30 } },
    });

    await expectCode(() => engine.optimize({ src: "gone2" }), "SOURCE_NOT_FOUND");
    await Bun.sleep(60);
    await expectCode(() => engine.optimize({ src: "gone2" }), "SOURCE_NOT_FOUND");
    expect(attempts).toBe(2);
  });

  test("negative caching can be turned off", async () => {
    let attempts = 0;
    const failing: SourceResolver = {
      name: "failing",
      supports: () => true,
      async identify() {
        return { id: "gone3", version: "v1" };
      },
      async resolve() {
        attempts++;
        throw new ImageError("SOURCE_NOT_FOUND", 404, "source not found");
      },
    };

    const engine = createImageEngine({
      resolvers: [failing],
      cache: { memory: {}, negative: false },
    });

    await expectCode(() => engine.optimize({ src: "gone3" }), "SOURCE_NOT_FOUND");
    await expectCode(() => engine.optimize({ src: "gone3" }), "SOURCE_NOT_FOUND");
    expect(attempts).toBe(2);
  });
});

describe("disk-backed engine", () => {
  test("survives a restart", async () => {
    const dir = join(scratch, "engine-disk");
    const build = () =>
      createImageEngine({
        local: { root },
        cache: { memory: {}, disk: { directory: dir } },
      });

    const first = await build().optimize({ src: "hero.png", transform: { width: 320, format: "webp" } });
    expect(first.cache).toBe("miss");

    // A fresh engine with cold memory still finds the entry on disk.
    const restarted = build();
    await restarted.sourceInfo({ src: "hero.png" }); // warm the per-source memo
    const second = await restarted.optimize({ src: "hero.png", transform: { width: 320, format: "webp" } });
    expect(second.cache).toBe("hit");
    expect(second.etag).toBe(first.etag);
  });

  test("a custom store replaces the built-in tiers", async () => {
    const store = memoryCache({ maxSize: "1MB" });
    const engine = createImageEngine({ local: { root }, cache: { store } });
    await engine.optimize({ src: "hero.png", transform: { width: 320, format: "webp" } });
    expect((await store.size()).entries).toBe(1);
  });
});
