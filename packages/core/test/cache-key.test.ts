import { describe, expect, test } from "bun:test";
import { cacheKey, canonicalString, etagFor, KEY_SCHEMA } from "../src/cache-key.ts";
import { normalize } from "../src/normalize.ts";
import { resolveConfig } from "../src/config.ts";
import type { NormalizedTransform, SourceIdentity } from "../src/types.ts";
import { imageQueryUrl, imageUrl, parseImageRequest } from "../src/url/index.ts";
import { fakeCaps } from "./helpers.ts";

const cfg = resolveConfig();
const caps = fakeCaps();
const source: SourceIdentity = { id: "/hero.jpg", version: "etag-abc" };

const t = (over: Partial<NormalizedTransform> = {}): NormalizedTransform =>
  Object.freeze({
    width: 800,
    height: null,
    fit: "inside",
    quality: 75,
    format: "webp",
    withoutEnlargement: true,
    autoOrient: true,
    ...over,
  });

describe("cacheKey", () => {
  test("is stable for identical inputs", () => {
    expect(cacheKey(source, t(), caps)).toBe(cacheKey(source, t(), caps));
  });

  test("has a recognizable prefix and fixed length", () => {
    const key = cacheKey(source, t(), caps);
    expect(key).toStartWith("bimg_");
    expect(key).toHaveLength(5 + 32);
  });

  describe("changes when any component changes", () => {
    const base = cacheKey(source, t(), caps);
    const cases: Array<[string, string]> = [
      ["width", cacheKey(source, t({ width: 640 }), caps)],
      ["height", cacheKey(source, t({ height: 480 }), caps)],
      ["fit", cacheKey(source, t({ fit: "fill" }), caps)],
      ["quality", cacheKey(source, t({ quality: 85 }), caps)],
      ["format", cacheKey(source, t({ format: "jpeg" }), caps)],
      ["withoutEnlargement", cacheKey(source, t({ withoutEnlargement: false }), caps)],
      ["autoOrient", cacheKey(source, t({ autoOrient: false }), caps)],
      ["source id", cacheKey({ id: "/other.jpg" }, t(), caps)],
      ["source version", cacheKey({ ...source, version: "etag-xyz" }, t(), caps)],
      ["bun version", cacheKey(source, t(), fakeCaps({ bunVersion: "1.5.0" }))],
      ["backend", cacheKey(source, t(), fakeCaps({ backend: "system" }))],
    ];
    for (const [name, key] of cases) {
      test(name, () => expect(key).not.toBe(base));
    }
  });

  test("does not change with capabilities that cannot affect output", () => {
    // The encodable format list is not part of the key: the *chosen* format is.
    const other = fakeCaps({ encode: ["jpeg", "png", "webp", "avif"] });
    expect(cacheKey(source, t(), other)).toBe(cacheKey(source, t(), caps));
  });

  test("backend is in the key because the two backends emit different bytes", () => {
    // Measured: identical requests produce different files on `system` vs `bun`
    // (pixels agree at SSIM 0.99923, the bytes do not). A cache shared across a
    // macOS dev box and a Linux server would serve entries the running backend
    // would never have produced.
    const system = cacheKey(source, t(), fakeCaps({ backend: "system" }));
    const bun = cacheKey(source, t(), fakeCaps({ backend: "bun" }));
    expect(system).not.toBe(bun);
  });

  test("a missing source version still produces a key", () => {
    expect(cacheKey({ id: "/a.jpg" }, t(), caps)).toStartWith("bimg_");
  });

  test("distinguishes an absent version from the literal placeholder", () => {
    expect(cacheKey({ id: "/a.jpg" }, t(), caps)).not.toBe(
      cacheKey({ id: "/a.jpg", version: "-" }, t(), caps),
    );
  });

  test("cannot be collided by shifting a delimiter between fields", () => {
    const a = cacheKey({ id: "a b", version: "c" }, t(), caps);
    const b = cacheKey({ id: "a", version: "b c" }, t(), caps);
    expect(a).not.toBe(b);
  });
});

describe("canonicalString", () => {
  test("carries the schema version so a shape change orphans old entries", () => {
    expect(canonicalString(source, t(), caps).split("\u0000")[0]).toBe(`s${KEY_SCHEMA}`);
  });

  test("includes bun version and backend", () => {
    const fields = canonicalString(source, t(), caps).split("\u0000");
    expect(fields).toContain("1.4.0");
    expect(fields).toContain("bun");
  });

  test("separates fields with NUL, which no field value can contain", () => {
    const fields = canonicalString({ id: "a b", version: "c d" }, t(), caps).split("\u0000");
    expect(fields).toContain("a b");
    expect(fields).toContain("vc d");
  });
});

describe("key stability across URL spellings", () => {
  const spellings = [
    "/_image/w_800,q_75,f_webp/hero.jpg",
    "/_image/q_75,f_webp,w_800/hero.jpg",
    "/_image/w_800/q_75/f_webp/hero.jpg",
    "/_image/f_webp/w_800,q_75/hero.jpg",
    "/_image?url=hero.jpg&w=800&q=75&f=webp",
    "/_image?q=75&url=hero.jpg&f=webp&w=800",
  ];

  test("every spelling of one request produces one key", () => {
    const keys = new Set(
      spellings.map((url) => {
        const parsed = parseImageRequest(url);
        const norm = normalize(parsed.transform, cfg, "webp");
        return cacheKey({ id: parsed.source.replace(/^\//, "") }, norm, caps);
      }),
    );
    expect(keys.size).toBe(1);
  });

  test("quantization collapses near-miss widths onto one key", () => {
    // The cache-cardinality attack: w=801, w=802, … must not each get an entry.
    const keys = new Set<string>();
    for (let w = 769; w <= 1024; w++) {
      const norm = normalize({ width: w }, cfg, "webp");
      keys.add(cacheKey(source, norm, caps));
    }
    expect(keys.size).toBe(1);
  });

  test("builder output feeds back into the same key", () => {
    const transform = { width: 800, quality: 75, format: "webp" } as const;
    const viaPath = parseImageRequest(imageUrl("/hero.jpg", transform));
    const viaQuery = parseImageRequest(imageQueryUrl("hero.jpg", transform));
    const keyOf = (t2: typeof viaPath) =>
      cacheKey({ id: "hero.jpg" }, normalize(t2.transform, cfg, "webp"), caps);
    expect(keyOf(viaPath)).toBe(keyOf(viaQuery));
  });
});

describe("etagFor", () => {
  test("is a quoted strong validator", () => {
    const etag = etagFor(new Uint8Array([1, 2, 3]));
    expect(etag).toStartWith('"bimg_');
    expect(etag).toEndWith('"');
  });

  test("is content-addressed, not key-addressed", () => {
    const a = etagFor(new Uint8Array([1, 2, 3]));
    const b = etagFor(new Uint8Array([1, 2, 3]));
    const c = etagFor(new Uint8Array([1, 2, 4]));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
