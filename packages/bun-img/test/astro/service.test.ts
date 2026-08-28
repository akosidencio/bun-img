/**
 * The Astro adapter is the one that exercises the engine directly: Astro hands
 * `transform()` bytes and expects bytes back. These tests drive that contract
 * without importing Astro, the same way the adapter itself does.
 */
import { describe, expect, test } from "bun:test";
import service, { createBunImageService } from "../../src/astro/index.ts";
import { expectCode, makeImage } from "../helpers.ts";

const svc = createBunImageService();

describe("validateOptions", () => {
  test("defaults the output format to webp", () => {
    expect(svc.validateOptions({ src: "/a.png" }).format).toBe("webp");
  });

  test("keeps an explicit supported format", () => {
    for (const format of ["webp", "png", "jpeg", "jpg", "avif"]) {
      expect(svc.validateOptions({ src: "/a.png", format }).format).toBe(format);
    }
  });

  test("rejects a format the engine can never produce", async () => {
    // Better a build-time error naming the problem than a silent substitution.
    await expectCode(() => svc.validateOptions({ src: "/a.png", format: "gif" }), "UNSUPPORTED_FORMAT");
    await expectCode(() => svc.validateOptions({ src: "/a.png", format: "svg" }), "UNSUPPORTED_FORMAT");
  });

  test("passes other options through untouched", () => {
    const out = svc.validateOptions({ src: "/a.png", width: 800, alt: "x" });
    expect(out.width).toBe(800);
    expect(out.alt).toBe("x");
  });
});

describe("getURL and parseURL round-trip", () => {
  test("carries every transform property", () => {
    const url = svc.getURL({
      src: "/hero.png",
      width: 800,
      height: 600,
      quality: 75,
      format: "webp",
      fit: "contain",
    });

    const parsed = svc.parseURL(new URL(url, "http://localhost"))!;
    expect(parsed.src).toBe("/hero.png");
    expect(parsed.width).toBe("800");
    expect(parsed.height).toBe("600");
    expect(parsed.quality).toBe("75");
    expect(parsed.format).toBe("webp");
    expect(parsed.fit).toBe("inside");
  });

  test("omits what was not asked for", () => {
    const parsed = svc.parseURL(new URL(svc.getURL({ src: "/a.png" }), "http://localhost"))!;
    expect(parsed).toEqual({ src: "/a.png" });
  });

  test("accepts an imported image object, not just a string", () => {
    // Astro passes ImageMetadata for local imports.
    const url = svc.getURL({ src: { src: "/_astro/hero.abc123.png", width: 1, height: 1 } });
    expect(url).toContain(encodeURIComponent("/_astro/hero.abc123.png"));
  });

  test("rejects a src it cannot serialize", async () => {
    await expectCode(() => svc.getURL({ src: 42 }), "INVALID_REQUEST");
  });

  test("returns undefined for a URL that is not ours", () => {
    expect(svc.parseURL(new URL("http://localhost/_image?other=1"))).toBeUndefined();
  });

  test("honours a custom endpoint", () => {
    const custom = createBunImageService({ endpoint: "/img" });
    expect(custom.getURL({ src: "/a.png" })).toStartWith("/img?");
  });

  test("survives sources with characters that need encoding", () => {
    const url = svc.getURL({ src: "/a b/c&d.png" });
    expect(svc.parseURL(new URL(url, "http://localhost"))!.src).toBe("/a b/c&d.png");
  });
});

describe("quality presets", () => {
  test("maps Astro's named presets onto numbers", () => {
    const q = (quality: string) =>
      svc.parseURL(new URL(svc.getURL({ src: "/a.png", quality }), "http://localhost"))!.quality;
    expect(q("low")).toBe("40");
    expect(q("mid")).toBe("60");
    expect(q("high")).toBe("80");
    expect(q("max")).toBe("95");
  });

  test("passes numeric quality through", () => {
    const url = svc.getURL({ src: "/a.png", quality: 82 });
    expect(svc.parseURL(new URL(url, "http://localhost"))!.quality).toBe("82");
  });
});

describe("fit translation", () => {
  test("maps the two values Bun actually has", () => {
    const fit = (value: string) =>
      svc.parseURL(new URL(svc.getURL({ src: "/a.png", fit: value }), "http://localhost"))!.fit;
    expect(fit("fill")).toBe("fill");
    expect(fit("contain")).toBe("inside");
  });

  test("falls back to inside for CSS values Bun cannot express", () => {
    // Bun has no crop, so cover/none/scale-down have no honest equivalent.
    // Falling back to `inside` never distorts; substituting `fill` would.
    for (const value of ["cover", "none", "scale-down"]) {
      const url = svc.getURL({ src: "/a.png", fit: value });
      expect(svc.parseURL(new URL(url, "http://localhost"))!.fit).toBe("inside");
    }
  });
});

describe("getHTMLAttributes", () => {
  test("emits dimensions to prevent layout shift", () => {
    const attrs = svc.getHTMLAttributes({ src: "/a.png", width: 800, height: 600, alt: "x" });
    expect(attrs.width).toBe(800);
    expect(attrs.height).toBe(600);
    expect(attrs.alt).toBe("x");
  });

  test("defaults loading and decoding", () => {
    const attrs = svc.getHTMLAttributes({ src: "/a.png", width: 100, height: 100 });
    expect(attrs.loading).toBe("lazy");
    expect(attrs.decoding).toBe("async");
  });

  test("lets the caller override those defaults", () => {
    const attrs = svc.getHTMLAttributes({
      src: "/a.png", width: 100, height: 100, loading: "eager", decoding: "sync",
    });
    expect(attrs.loading).toBe("eager");
    expect(attrs.decoding).toBe("sync");
  });

  test("does not leak transform options into the markup", () => {
    // format/quality/fit shaped the bytes; they are not HTML attributes.
    const attrs = svc.getHTMLAttributes({
      src: "/a.png", width: 100, height: 100, format: "webp", quality: 80, fit: "contain",
    });
    expect(attrs).not.toHaveProperty("src");
    expect(attrs).not.toHaveProperty("format");
    expect(attrs).not.toHaveProperty("quality");
    expect(attrs).not.toHaveProperty("fit");
  });

  test("does not leak Astro's own directives either", () => {
    // These select which variants get generated. Left in, Astro renders
    // `widths="320,640,900"` onto the tag as if it were a real attribute.
    const attrs = svc.getHTMLAttributes({
      src: "/a.png",
      width: 100,
      height: 100,
      widths: [320, 640],
      densities: [1, 2],
      formats: ["webp"],
      fallbackFormat: "png",
      pictureAttributes: { class: "x" },
      inferSize: true,
      priority: true,
    });
    for (const key of [
      "widths", "densities", "formats", "fallbackFormat",
      "pictureAttributes", "inferSize", "priority",
    ]) {
      expect(attrs).not.toHaveProperty(key);
    }
  });
});

describe("getSrcSet", () => {
  test("one variant per width, with w descriptors", () => {
    // Without this, <Picture> renders `<source srcset>` empty and falls back to
    // the unresized original — silently, with no error anywhere.
    const set = svc.getSrcSet({ src: "/a.png", widths: [320, 640, 900], format: "webp" });
    expect(set).toHaveLength(3);
    expect(set.map((v) => v.descriptor)).toEqual(["320w", "640w", "900w"]);
    expect(set.map((v) => v.transform.width)).toEqual([320, 640, 900]);
    // The rest of the transform rides along, or the variants would differ in
    // format from the source element that references them.
    expect(set.every((v) => v.transform.format === "webp")).toBe(true);
  });

  test("densities multiply the declared width", () => {
    const set = svc.getSrcSet({ src: "/a.png", width: 400, densities: [1, 2, 3] });
    expect(set.map((v) => v.descriptor)).toEqual(["1x", "2x", "3x"]);
    expect(set.map((v) => v.transform.width)).toEqual([400, 800, 1200]);
  });

  test("accepts densities written as 2x strings", () => {
    const set = svc.getSrcSet({ src: "/a.png", width: 100, densities: ["1x", "2x"] });
    expect(set.map((v) => v.transform.width)).toEqual([100, 200]);
  });

  test("densities need a base width to scale", () => {
    expect(svc.getSrcSet({ src: "/a.png", densities: [2] })).toEqual([]);
  });

  test("no widths and no densities means no variants", () => {
    expect(svc.getSrcSet({ src: "/a.png", width: 400 })).toEqual([]);
  });

  test("ignores entries that are not numbers", () => {
    const set = svc.getSrcSet({ src: "/a.png", widths: [320, "nope", 640] });
    expect(set.map((v) => v.transform.width)).toEqual([320, 640]);
  });
});

describe("transform — the engine boundary", () => {
  test("takes bytes and returns bytes, with no HTTP in between", async () => {
    const input = await makeImage(1000, 500, "png");
    const out = await svc.transform(input, { src: "/hero.png", width: "320", format: "webp" });

    expect(out.format).toBe("webp");
    expect(out.data).toBeInstanceOf(Uint8Array);
    // RIFF….WEBP
    expect(String.fromCharCode(...out.data.slice(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...out.data.slice(8, 12))).toBe("WEBP");
  });

  test("resizes to the requested width, preserving aspect ratio", async () => {
    const input = await makeImage(1000, 500, "png");
    const out = await svc.transform(input, { src: "/a.png", width: "320", format: "png" });
    const meta = await new Bun.Image(out.data).metadata();
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(160);
  });

  test("honours fit: fill", async () => {
    const input = await makeImage(1000, 500, "png");
    const out = await svc.transform(input, {
      src: "/a.png", width: "300", height: "300", fit: "fill", format: "png",
    });
    const meta = await new Bun.Image(out.data).metadata();
    expect([meta.width, meta.height]).toEqual([300, 300]);
  });

  test("emits each format Bun can encode", async () => {
    const input = await makeImage(400, 400, "png");
    for (const [requested, expected] of [["png", "png"], ["jpeg", "jpeg"], ["jpg", "jpeg"], ["webp", "webp"]] as const) {
      const out = await svc.transform(input, { src: "/a.png", width: "200", format: requested });
      expect(out.format).toBe(expected);
      expect((await new Bun.Image(out.data).metadata()).format).toBe(expected);
    }
  });

  test("reports the format actually produced when one is unavailable", async () => {
    // AVIF encodes nowhere on Linux. Claiming `avif` while returning WebP bytes
    // would make Astro write a file with the wrong extension.
    const input = await makeImage(200, 200, "png");
    const out = await svc.transform(input, { src: "/a.png", width: "100", format: "avif" });
    const actual = (await new Bun.Image(out.data).metadata()).format;
    expect(out.format).toBe(actual);
  });

  test("defaults to webp when no format is given", async () => {
    const input = await makeImage(200, 200, "png");
    const out = await svc.transform(input, { src: "/a.png", width: "100" });
    expect(out.format).toBe("webp");
  });

  test("rejects bytes that are not an image", async () => {
    const junk = new TextEncoder().encode("<html>not an image</html>");
    await expectCode(() => svc.transform(junk, { src: "/a.html", width: "100" }), "UNSUPPORTED_FORMAT");
  });

  test("honours the author's exact width, rather than quantizing it", async () => {
    // Astro writes the declared width into the markup and separately asks us
    // for bytes. Snapping 250 up to an allowed width would make `width="250"`
    // disagree with a 320px file — a layout bug nothing would report.
    const input = await makeImage(1000, 1000, "png");
    const out = await svc.transform(input, { src: "/a.png", width: "250", format: "png" });
    expect((await new Bun.Image(out.data).metadata()).width).toBe(250);
  });

  test("honours the author's exact quality too", async () => {
    // The named presets (40/60/80/95) are mostly absent from the default
    // quality list, so quantizing would silently re-grade every image.
    const input = await makeImage(400, 400, "jpeg");
    const a = await svc.transform(input, { src: "/a.jpg", width: "300", quality: "40", format: "jpeg" });
    const b = await svc.transform(input, { src: "/a.jpg", width: "300", quality: "95", format: "jpeg" });
    expect(a.data.byteLength).toBeLessThan(b.data.byteLength);
  });

  test("quantization can still be turned on explicitly", async () => {
    const quantized = createBunImageService({ quantize: true, widths: [200, 400] });
    const input = await makeImage(1000, 1000, "png");
    const out = await quantized.transform(input, { src: "/a.png", width: "250", format: "png" });
    expect((await new Bun.Image(out.data).metadata()).width).toBe(400);
  });

  test("engine config otherwise reaches the transform", async () => {
    const limited = createBunImageService({ limits: { maxWidth: 100 } });
    const input = await makeImage(400, 400, "png");
    await expectCode(
      () => limited.transform(input, { src: "/a.png", width: "300", format: "png" }),
      "INVALID_REQUEST",
    );
  });
});

describe("default export", () => {
  test("is a usable service, which is what Astro loads", () => {
    // Astro imports `service.entrypoint` and uses its default export directly.
    expect(typeof service.getURL).toBe("function");
    expect(typeof service.parseURL).toBe("function");
    expect(typeof service.transform).toBe("function");
    expect(typeof service.validateOptions).toBe("function");
    expect(typeof service.getHTMLAttributes).toBe("function");
  });

  test("declares the properties that affect output, for Astro's hashing", () => {
    // A missing property here makes two different images collide on one file.
    expect(service.propertiesToHash).toEqual([
      "src", "width", "height", "format", "quality", "fit",
    ]);
  });
});
