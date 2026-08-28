import { describe, expect, test } from "bun:test";
import { fallbackFor, negotiate, parseAccept } from "../src/negotiate.ts";
import { resolveConfig } from "../src/config.ts";
import { expectCode, fakeCaps } from "./helpers.ts";

const cfg = resolveConfig();
const caps = fakeCaps();

describe("parseAccept", () => {
  test("reads explicit image tokens", () => {
    expect([...parseAccept("image/avif,image/webp")].sort()).toEqual(["avif", "webp"]);
  });

  test("treats jpg as jpeg", () => {
    expect(parseAccept("image/jpg").has("jpeg")).toBe(true);
  });

  test("ignores wildcards", () => {
    // Chrome sends image/avif,image/webp,image/apng,*/*;q=0.8 — honouring the
    // wildcard would hand WebP to clients that never asked for it.
    expect(parseAccept("*/*").size).toBe(0);
    expect(parseAccept("image/*").size).toBe(0);
    expect([...parseAccept("image/webp,*/*;q=0.8")]).toEqual(["webp"]);
  });

  test("honours q=0 as a refusal", () => {
    expect(parseAccept("image/webp;q=0").has("webp")).toBe(false);
    expect(parseAccept("image/webp;q=0.1").has("webp")).toBe(true);
  });

  test("tolerates whitespace and case", () => {
    expect([...parseAccept(" IMAGE/WEBP ; q=0.9 ")]).toEqual(["webp"]);
  });

  test("returns empty for null, empty, and junk", () => {
    expect(parseAccept(null).size).toBe(0);
    expect(parseAccept("").size).toBe(0);
    expect(parseAccept("text/html,application/json").size).toBe(0);
  });
});

describe("fallbackFor", () => {
  test("alpha-capable sources go to PNG, never JPEG", () => {
    // Bun does not flatten alpha — it drops the channel and keeps whatever RGB
    // sits underneath, which varies by source encoder.
    for (const source of ["png", "gif", "webp", "avif", "heic", "bmp"] as const) {
      expect(fallbackFor(source, caps)).toBe("png");
    }
  });

  test("opaque sources go to JPEG", () => {
    expect(fallbackFor("jpeg", caps)).toBe("jpeg");
    expect(fallbackFor("tiff", caps)).toBe("jpeg");
  });

  test("falls through when the preferred target is not encodable", () => {
    const noPng = fakeCaps({ encode: ["jpeg", "webp"] });
    expect(fallbackFor("png", noPng)).toBe("webp");
    const onlyJpeg = fakeCaps({ encode: ["jpeg"] });
    expect(fallbackFor("png", onlyJpeg)).toBe("jpeg");
  });

  test("throws when nothing can be encoded", async () => {
    await expectCode(() => fallbackFor("jpeg", fakeCaps({ encode: [] })), "UNSUPPORTED_FORMAT");
  });
});

describe("negotiate", () => {
  test("honours an explicit encodable format", () => {
    const r = negotiate("webp", null, "jpeg", caps, cfg);
    expect(r).toEqual({ format: "webp", negotiated: false });
  });

  test("an explicit format does not vary on Accept", () => {
    const a = negotiate("png", "image/avif", "jpeg", caps, cfg);
    const b = negotiate("png", null, "jpeg", caps, cfg);
    expect(a.negotiated).toBe(false);
    expect(a.format).toBe(b.format);
  });

  test("downgrades an unencodable explicit format by default", () => {
    // AVIF encodes nowhere reachable — this must never be a 500.
    const r = negotiate("avif", null, "jpeg", caps, cfg);
    expect(r.format).toBe("jpeg");
  });

  test("rejects an unencodable explicit format in reject mode", async () => {
    const strict = resolveConfig({ onUnsupportedFormat: "reject" });
    await expectCode(() => negotiate("avif", null, "jpeg", caps, strict), "UNSUPPORTED_FORMAT");
  });

  test("auto picks the first configured format the client accepts", () => {
    const r = negotiate("auto", "image/webp,image/jpeg", "jpeg", caps, cfg);
    expect(r).toEqual({ format: "webp", negotiated: true });
  });

  test("auto respects configured preference order", () => {
    const jpegFirst = resolveConfig({ formats: ["jpeg", "webp"] });
    const r = negotiate("auto", "image/webp,image/jpeg", "jpeg", caps, jpegFirst);
    expect(r.format).toBe("jpeg");
  });

  test("auto skips a configured format this runtime cannot encode", () => {
    const avifFirst = resolveConfig({ formats: ["avif", "webp", "jpeg"] });
    const r = negotiate("auto", "image/avif,image/webp", "jpeg", caps, avifFirst);
    expect(r.format).toBe("webp");
  });

  test("auto falls back to a compatible format for a legacy client", () => {
    const r = negotiate("auto", "image/jpeg", "jpeg", caps, cfg);
    expect(r.format).toBe("jpeg");
    expect(r.negotiated).toBe(true);
  });

  test("auto keeps alpha for a PNG source when the client is legacy", () => {
    const r = negotiate("auto", "image/jpeg", "png", caps, cfg);
    expect(r.format).toBe("png");
  });

  test("auto with no Accept still reports negotiated, so Vary is sent", () => {
    // A different Accept would have produced a different answer.
    const r = negotiate("auto", null, "jpeg", caps, cfg);
    expect(r.negotiated).toBe(true);
  });
});
