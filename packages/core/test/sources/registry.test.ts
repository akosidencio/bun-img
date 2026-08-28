import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSourceRegistry } from "../../src/sources/registry.ts";
import { createLocalResolver } from "../../src/sources/local.ts";
import { createImageEngine } from "../../src/engine.ts";
import { resolveConfig } from "../../src/config.ts";
import type { SourceResolver } from "../../src/sources/types.ts";
import { expectCode, makeImage } from "../helpers.ts";

const cfg = resolveConfig();
const ctx = { config: cfg };

let root: string;

beforeAll(async () => {
  root = join(tmpdir(), `bun-img-registry-${Bun.randomUUIDv7()}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "hero.png"), await makeImage(1000, 500, "png"));
  await writeFile(join(root, "square.png"), await makeImage(400, 400, "png"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("dispatch", () => {
  test("routes to the first resolver that claims the source", async () => {
    const calls: string[] = [];
    const make = (name: string, claims: (s: string) => boolean): SourceResolver => ({
      name,
      supports: claims,
      async resolve() {
        calls.push(name);
        return { data: new Uint8Array([1]), identity: { id: name }, kind: "custom" as const };
      },
    });

    const registry = createSourceRegistry({
      resolvers: [make("first", (s) => s.startsWith("a")), make("second", () => true)],
    });

    expect((await registry.resolve("abc", ctx)).identity.id).toBe("first");
    expect((await registry.resolve("xyz", ctx)).identity.id).toBe("second");
    expect(calls).toEqual(["first", "second"]);
  });

  test("refuses a source nothing claims", async () => {
    const registry = createSourceRegistry({ resolvers: [] });
    await expectCode(() => registry.resolve("anything", ctx), "SOURCE_NOT_ALLOWED");
  });

  test("refuses an empty source", async () => {
    const registry = createSourceRegistry({ resolvers: [createLocalResolver({ root })] });
    await expectCode(() => registry.resolve("", ctx), "INVALID_REQUEST");
  });
});

describe("metadata memoization", () => {
  test("computes once per key", async () => {
    const registry = createSourceRegistry({ resolvers: [] });
    let calls = 0;
    const compute = async () => {
      calls++;
      return { width: 1, height: 1, format: "png" as const };
    };

    await registry.info("k", compute);
    await registry.info("k", compute);
    await registry.info("k", compute);
    expect(calls).toBe(1);
  });

  test("concurrent misses share one computation", async () => {
    // Caching the promise, not the value, is what makes this true.
    const registry = createSourceRegistry({ resolvers: [] });
    let calls = 0;
    const compute = async () => {
      calls++;
      await Bun.sleep(10);
      return { width: 1, height: 1, format: "png" as const };
    };

    await Promise.all([
      registry.info("k", compute),
      registry.info("k", compute),
      registry.info("k", compute),
    ]);
    expect(calls).toBe(1);
  });

  test("a failure is not cached", async () => {
    // Otherwise a transient decode error pins itself for the process lifetime.
    const registry = createSourceRegistry({ resolvers: [] });
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error("nope");
    };

    await registry.info("k", failing).catch(() => {});
    await registry.info("k", failing).catch(() => {});
    expect(calls).toBe(2);
  });

  test("evicts the least recently used entry past the limit", async () => {
    const registry = createSourceRegistry({ resolvers: [], maxInfoEntries: 2 });
    const info = (n: number) => async () => ({ width: n, height: n, format: "png" as const });

    await registry.info("a", info(1));
    await registry.info("b", info(2));
    await registry.info("a", info(99)); // reading refreshes a
    await registry.info("c", info(3)); // evicts b, the least recently used

    // Check the survivor first: probing the evicted key would re-insert it and
    // evict something else in turn.
    let aRecomputed = false;
    await registry.info("a", async () => {
      aRecomputed = true;
      return { width: 0, height: 0, format: "png" as const };
    });
    expect(aRecomputed).toBe(false);

    let bRecomputed = false;
    await registry.info("b", async () => {
      bRecomputed = true;
      return { width: 0, height: 0, format: "png" as const };
    });
    expect(bRecomputed).toBe(true);
  });

  test("placeholders and info are separate caches", async () => {
    const registry = createSourceRegistry({ resolvers: [] });
    await registry.info("k", async () => ({ width: 1, height: 1, format: "png" as const }));
    let called = false;
    await registry.placeholder("k", async () => {
      called = true;
      return "data:...";
    });
    expect(called).toBe(true);
  });

  test("clear drops everything", async () => {
    const registry = createSourceRegistry({ resolvers: [] });
    await registry.info("k", async () => ({ width: 1, height: 1, format: "png" as const }));
    registry.clear();
    let recomputed = false;
    await registry.info("k", async () => {
      recomputed = true;
      return { width: 1, height: 1, format: "png" as const };
    });
    expect(recomputed).toBe(true);
  });
});

describe("engine with local sources", () => {
  test("optimizes a file by path", async () => {
    const engine = createImageEngine({ local: { root } });
    const out = await engine.optimize({ src: "hero.png", transform: { width: 320, format: "webp" } });
    expect(out.width).toBe(320);
    expect(out.height).toBe(160);
    expect(out.format).toBe("webp");
  });

  test("plan exposes the resolved source and its identity", async () => {
    const engine = createImageEngine({ local: { root } });
    const plan = await engine.plan({ src: "hero.png", transform: { width: 320 } });
    expect(plan.resolved?.kind).toBe("local");
    expect(plan.identity.id).toContain("hero.png");
    expect(plan.identity.version).toMatch(/^\d+:\d+$/);
    expect(plan.sourceInfo).toEqual({ width: 1000, height: 500, format: "png" });
  });

  test("refuses traversal through the engine", async () => {
    const engine = createImageEngine({ local: { root } });
    await expectCode(
      () => engine.optimize({ src: "../../etc/passwd", transform: { width: 320 } }),
      "SOURCE_NOT_FOUND",
    );
  });

  test("refuses a remote URL when remote is not configured", async () => {
    const engine = createImageEngine({ local: { root } });
    await expectCode(
      () => engine.optimize({ src: "https://example.com/a.png" }),
      "SOURCE_NOT_ALLOWED",
    );
  });

  test("refuses both src and source together", async () => {
    const engine = createImageEngine({ local: { root } });
    await expectCode(
      () => engine.optimize({ src: "hero.png", source: new Uint8Array([1]) }),
      "INVALID_REQUEST",
    );
  });

  test("refuses neither src nor source", async () => {
    const engine = createImageEngine({ local: { root } });
    await expectCode(() => engine.optimize({}), "INVALID_REQUEST");
  });

  test("reads the source only once per optimize", async () => {
    // plan() and optimize() must not each fetch the bytes.
    let reads = 0;
    const counting: SourceResolver = {
      name: "counting",
      supports: () => true,
      async resolve() {
        reads++;
        return {
          data: await makeImage(800, 800, "png"),
          identity: { id: "counted", version: "1" },
          kind: "custom" as const,
        };
      },
    };
    const engine = createImageEngine({ resolvers: [counting] });
    await engine.optimize({ src: "anything", transform: { width: 320, format: "webp" } });
    expect(reads).toBe(1);
  });

  test("source metadata is cached across transforms of the same file", async () => {
    const engine = createImageEngine({ local: { root } });
    const a = await engine.sourceInfo({ src: "square.png" });
    const b = await engine.sourceInfo({ src: "square.png" });
    expect(a).toBe(b);
  });

  test("placeholders are cached per source, independent of transform", async () => {
    const engine = createImageEngine({ local: { root } });
    const first = await engine.placeholder({ src: "square.png" });
    await engine.optimize({ src: "square.png", transform: { width: 320, format: "webp" } });
    const second = await engine.placeholder({ src: "square.png" });
    expect(second).toBe(first);
    expect(first).toStartWith("data:image/png;base64,");
  });

  test("placeholder still accepts bare bytes", async () => {
    const engine = createImageEngine({ local: { root } });
    const p = await engine.placeholder(await makeImage(200, 200, "jpeg"));
    expect(p).toStartWith("data:image/png;base64,");
  });

  test("two different files get different cache keys", async () => {
    const engine = createImageEngine({ local: { root } });
    const a = await engine.plan({ src: "hero.png", transform: { width: 320 } });
    const b = await engine.plan({ src: "square.png", transform: { width: 320 } });
    expect(a.key).not.toBe(b.key);
  });

  test("the same file at two widths gets different cache keys", async () => {
    const engine = createImageEngine({ local: { root } });
    const a = await engine.plan({ src: "hero.png", transform: { width: 320 } });
    const b = await engine.plan({ src: "hero.png", transform: { width: 640 } });
    expect(a.key).not.toBe(b.key);
  });
});
