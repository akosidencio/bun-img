import { describe, expect, test } from "bun:test";
import { normalize, quantizeQuality, quantizeWidth } from "../src/normalize.ts";
import { resolveConfig } from "../src/config.ts";
import { expectCode } from "./helpers.ts";

const cfg = resolveConfig();

describe("quantizeWidth", () => {
  test("passes an exact allowed width through", () => {
    expect(quantizeWidth(768, cfg)).toBe(768);
  });

  test("snaps up to the next allowed width", () => {
    expect(quantizeWidth(813, cfg)).toBe(1024);
    expect(quantizeWidth(321, cfg)).toBe(480);
    expect(quantizeWidth(1, cfg)).toBe(320);
  });

  test("clamps above the largest allowed width rather than inventing an entry", () => {
    expect(quantizeWidth(99_999, cfg)).toBe(1920);
  });

  test("collapses a cardinality flood onto the allowed list", () => {
    const produced = new Set<number>();
    for (let w = 1; w <= 2000; w++) produced.add(quantizeWidth(w, cfg));
    expect(produced.size).toBe(cfg.widths.length);
  });

  test("strict mode rejects instead of snapping", async () => {
    const strict = resolveConfig({ strictWidths: true });
    expect(quantizeWidth(768, strict)).toBe(768);
    await expectCode(() => quantizeWidth(813, strict), "INVALID_REQUEST");
  });
});

describe("quantizeQuality", () => {
  test("passes an exact allowed quality through", () => {
    expect(quantizeQuality(75, cfg)).toBe(75);
  });

  test("snaps to the nearest allowed quality", () => {
    expect(quantizeQuality(79, cfg)).toBe(75);
    expect(quantizeQuality(81, cfg)).toBe(85);
    expect(quantizeQuality(1, cfg)).toBe(60);
    expect(quantizeQuality(100, cfg)).toBe(85);
  });

  test("breaks ties upward, favouring quality", () => {
    // 60 and 75 are equidistant from 67.5; 68 is nearer 75, 67 nearer 60.
    const midpoint = resolveConfig({ qualities: [60, 80] });
    expect(quantizeQuality(70, midpoint)).toBe(80);
  });

  test("collapses q=1..100 onto the allowed list", () => {
    const produced = new Set<number>();
    for (let q = 1; q <= 100; q++) produced.add(quantizeQuality(q, cfg));
    expect(produced.size).toBe(cfg.qualities.length);
  });

  test("strict mode rejects instead of snapping", async () => {
    const strict = resolveConfig({ strictQualities: true });
    await expectCode(() => quantizeQuality(79, strict), "INVALID_REQUEST");
  });
});

describe("normalize", () => {
  test("fills every field from config defaults", () => {
    const t = normalize({}, cfg, "webp");
    expect(t).toEqual({
      width: null,
      height: null,
      fit: "inside",
      quality: 75,
      format: "webp",
      withoutEnlargement: true,
      autoOrient: true,
    });
  });

  test("uses the negotiated format, never the requested one", () => {
    const t = normalize({ format: "avif" }, cfg, "webp");
    expect(t.format).toBe("webp");
  });

  test("caller values override defaults", () => {
    const t = normalize(
      { width: 640, height: 480, fit: "fill", quality: 85, withoutEnlargement: false, autoOrient: false },
      cfg,
      "jpeg",
    );
    expect(t).toEqual({
      width: 640,
      height: 480,
      fit: "fill",
      quality: 85,
      format: "jpeg",
      withoutEnlargement: false,
      autoOrient: false,
    });
  });

  test("is order-independent — the property the cache key depends on", () => {
    const a = normalize({ width: 800, quality: 75, fit: "inside" }, cfg, "webp");
    const b = normalize({ fit: "inside", quality: 75, width: 800 }, cfg, "webp");
    expect(a).toEqual(b);
  });

  test("returns a frozen object", () => {
    const t = normalize({}, cfg, "webp");
    expect(Object.isFrozen(t)).toBe(true);
  });

  describe("rejects invalid input", () => {
    const cases: Array<[string, Parameters<typeof normalize>[0]]> = [
      ["zero width", { width: 0 }],
      ["negative width", { width: -100 }],
      ["fractional width", { width: 800.5 }],
      ["width over maxWidth", { width: 20_000 }],
      ["zero height", { height: 0 }],
      ["height over maxHeight", { height: 20_000 }],
      ["fractional quality", { quality: 75.5 }],
      ["quality 0", { quality: 0 }],
      ["quality 101", { quality: 101 }],
    ];
    for (const [name, transform] of cases) {
      test(name, async () => {
        await expectCode(() => normalize(transform, cfg, "webp"), "INVALID_REQUEST");
      });
    }
  });
});
