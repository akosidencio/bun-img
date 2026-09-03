import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createImageEngine } from "../src/engine.ts";
import { capabilities } from "../src/capabilities.ts";
import { contentTypeFor, readSourceInfo, runTransform } from "../src/transform.ts";
import { resolveConfig } from "../src/config.ts";
import { expectCode, makeImage } from "./helpers.ts";

const cfg = resolveConfig();
const engine = createImageEngine();

// Every one of these formats encodes on every platform Phase 0 measured.
const PORTABLE = ["jpeg", "png", "webp"] as const;

describe("capabilities", () => {
  test("reports the running runtime", async () => {
    const caps = await capabilities();
    expect(caps.bunVersion).toBe(Bun.version);
    expect(caps.backend).toBe(Bun.Image.backend);
    expect(caps.platform).toContain(process.platform);
  });

  test("JPEG, PNG and WebP encode everywhere", async () => {
    const caps = await capabilities();
    for (const format of PORTABLE) expect(caps.encode).toContain(format);
  });

  test("probes decode separately from encode", async () => {
    const caps = await capabilities();
    for (const format of PORTABLE) expect(caps.decode).toContain(format);
    // GIF decodes (first frame) everywhere but never encodes.
    expect(caps.decode).toContain("gif");
    expect(caps.encode).not.toContain("gif" as never);
  });

  test("memoizes — a second probe is the same object", async () => {
    expect(await capabilities()).toBe(await capabilities());
  });

  test("is frozen", async () => {
    expect(Object.isFrozen(await capabilities())).toBe(true);
  });
});

describe("readSourceInfo", () => {
  test("reports dimensions and container format", async () => {
    const png = await makeImage(300, 200, "png");
    expect(await readSourceInfo(png, cfg)).toEqual({ width: 300, height: 200, format: "png" });
  });

  test("identifies each portable format", async () => {
    for (const format of PORTABLE) {
      const bytes = await makeImage(64, 48, format);
      const info = await readSourceInfo(bytes, cfg);
      expect(info.format).toBe(format);
    }
  });

  test("rejects HTML pretending to be an image", async () => {
    const html = new TextEncoder().encode("<html><body>not an image</body></html>");
    await expectCode(() => readSourceInfo(html, cfg), "UNSUPPORTED_FORMAT");
  });

  test("rejects empty input", async () => {
    await expectCode(() => readSourceInfo(new Uint8Array(0), cfg), "UNSUPPORTED_FORMAT");
  });

  test("enforces maxPixels before allocating a pixel buffer", async () => {
    const big = await makeImage(2000, 2000, "png");
    const tiny = resolveConfig({ limits: { maxPixels: 1000 } });
    await expectCode(() => readSourceInfo(big, tiny), "IMAGE_TOO_LARGE");
  });
});

describe("runTransform", () => {
  test("resizes preserving aspect ratio under fit: inside", async () => {
    const src = await makeImage(1000, 500, "png");
    const out = await runTransform(src, {
      width: 400, height: null, fit: "inside", quality: 75, format: "webp",
      withoutEnlargement: true, autoOrient: true,
    }, cfg);
    expect(out.width).toBe(400);
    expect(out.height).toBe(200);
  });

  test("fit: fill stretches to exactly the requested box", async () => {
    const src = await makeImage(1000, 500, "png");
    const out = await runTransform(src, {
      width: 300, height: 300, fit: "fill", quality: 75, format: "webp",
      withoutEnlargement: false, autoOrient: true,
    }, cfg);
    expect([out.width, out.height]).toEqual([300, 300]);
  });

  test("withoutEnlargement leaves a smaller source alone", async () => {
    const src = await makeImage(100, 100, "png");
    const out = await runTransform(src, {
      width: 800, height: null, fit: "inside", quality: 75, format: "webp",
      withoutEnlargement: true, autoOrient: true,
    }, cfg);
    expect(out.width).toBe(100);
  });

  test("enlargement happens when explicitly allowed", async () => {
    const src = await makeImage(100, 100, "png");
    const out = await runTransform(src, {
      width: 400, height: null, fit: "inside", quality: 75, format: "webp",
      withoutEnlargement: false, autoOrient: true,
    }, cfg);
    expect(out.width).toBe(400);
  });

  test("a null width passes the source through at its own size", async () => {
    const src = await makeImage(123, 45, "png");
    const out = await runTransform(src, {
      width: null, height: null, fit: "inside", quality: 75, format: "webp",
      withoutEnlargement: true, autoOrient: true,
    }, cfg);
    expect([out.width, out.height]).toEqual([123, 45]);
  });

  test("emits each portable format with the right magic bytes", async () => {
    const src = await makeImage(64, 64, "png");
    const magic: Record<string, (b: Uint8Array) => boolean> = {
      png: (b) => b[0] === 0x89 && b[1] === 0x50,
      jpeg: (b) => b[0] === 0xff && b[1] === 0xd8,
      webp: (b) =>
        String.fromCharCode(...b.slice(0, 4)) === "RIFF" &&
        String.fromCharCode(...b.slice(8, 12)) === "WEBP",
    };
    for (const format of PORTABLE) {
      const out = await runTransform(src, {
        width: 32, height: null, fit: "inside", quality: 75, format,
        withoutEnlargement: true, autoOrient: true,
      }, cfg);
      expect(magic[format]!(out.bytes)).toBe(true);
    }
  });

  test("enforces maxOutputBytes", async () => {
    const src = await makeImage(500, 500, "png");
    const tight = resolveConfig({ limits: { maxOutputBytes: 10 } });
    await expectCode(
      () =>
        runTransform(src, {
          width: 500, height: null, fit: "inside", quality: 85, format: "png",
          withoutEnlargement: true, autoOrient: true,
        }, tight),
      "IMAGE_TOO_LARGE",
    );
  });

  test("rejects a resize that would exceed maxPixels", async () => {
    const src = await makeImage(100, 100, "png");
    const small = resolveConfig({ limits: { maxPixels: 20_000 } });
    await expectCode(
      () =>
        runTransform(src, {
          width: 5000, height: 5000, fit: "fill", quality: 75, format: "webp",
          withoutEnlargement: false, autoOrient: true,
        }, small),
      "IMAGE_TOO_LARGE",
    );
  });
});

describe("contentTypeFor", () => {
  test("maps every format", () => {
    expect(contentTypeFor("jpeg")).toBe("image/jpeg");
    expect(contentTypeFor("png")).toBe("image/png");
    expect(contentTypeFor("webp")).toBe("image/webp");
    expect(contentTypeFor("avif")).toBe("image/avif");
    expect(contentTypeFor("heic")).toBe("image/heic");
  });
});

describe("engine.optimize", () => {
  test("produces a complete result", async () => {
    const src = await makeImage(1000, 500, "png");
    const out = await engine.optimize({
      source: src,
      transform: { width: 320, format: "webp" },
    });

    expect(out.width).toBe(320);
    expect(out.height).toBe(160);
    expect(out.format).toBe("webp");
    expect(out.contentType).toBe("image/webp");
    expect(out.size).toBeGreaterThan(0);
    expect(out.size).toBe(out.body.size);
    expect(out.etag).toStartWith('"bimg_');
    expect(Object.isFrozen(out)).toBe(true);
  });

  test("body is a Blob carrying the content type", async () => {
    const src = await makeImage(200, 200, "png");
    const out = await engine.optimize({ source: src, transform: { width: 64, format: "png" } });
    expect(out.body.type).toBe("image/png");
    expect((await out.body.bytes()).byteLength).toBe(out.size);
  });

  test("quantizes an arbitrary width", async () => {
    const src = await makeImage(2000, 1000, "png");
    const out = await engine.optimize({ source: src, transform: { width: 813, format: "webp" } });
    expect(out.width).toBe(1024);
  });

  test("negotiates WebP for a modern client", async () => {
    const src = await makeImage(200, 200, "jpeg");
    const out = await engine.optimize({
      source: src,
      transform: { width: 64 },
      accept: "image/webp,image/jpeg",
    });
    expect(out.format).toBe("webp");
    expect(out.negotiated).toBe(true);
  });

  test("serves JPEG to a legacy client", async () => {
    const src = await makeImage(200, 200, "jpeg");
    const out = await engine.optimize({
      source: src,
      transform: { width: 64 },
      accept: "image/jpeg",
    });
    expect(out.format).toBe("jpeg");
  });

  test("never auto-negotiates a PNG source to JPEG", async () => {
    // Bun drops alpha rather than flattening it, so this would be unpredictable.
    const src = await makeImage(200, 200, "png");
    const out = await engine.optimize({
      source: src,
      transform: { width: 64 },
      accept: "image/jpeg",
    });
    expect(out.format).not.toBe("jpeg");
  });

  test("an explicit format does not vary on Accept", async () => {
    const src = await makeImage(200, 200, "jpeg");
    const out = await engine.optimize({
      source: src,
      transform: { width: 64, format: "png" },
      accept: "image/webp",
    });
    expect(out.format).toBe("png");
    expect(out.negotiated).toBe(false);
  });

  test("resolves a height-only request to a width", async () => {
    const src = await makeImage(1000, 500, "png");
    const out = await engine.optimize({
      source: src,
      transform: { height: 100, format: "webp" },
    });
    // 1000x500 at height 100 wants width 200, which quantizes up to 320.
    expect(out.height).toBeLessThanOrEqual(320);
    expect(out.width).toBeGreaterThan(0);
  });

  test("accepts a Blob source", async () => {
    const src = await makeImage(1000, 1000, "png");
    const out = await engine.optimize({
      source: new Blob([src]),
      transform: { width: 320, format: "webp" },
    });
    expect(out.width).toBe(320);
  });

  test("accepts a BunFile source", async () => {
    const path = `${import.meta.dir}/../../../.tmp-bunfile.png`;
    await Bun.write(path, await makeImage(1000, 1000, "png"));
    try {
      const out = await engine.optimize({
        source: Bun.file(path),
        transform: { width: 320, format: "webp" },
      });
      expect(out.width).toBe(320);
    } finally {
      await Bun.file(path).delete();
    }
  });

  test("accepts an ArrayBuffer source", async () => {
    const src = await makeImage(1000, 1000, "png");
    const out = await engine.optimize({
      source: src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer,
      transform: { width: 320, format: "webp" },
    });
    expect(out.width).toBe(320);
  });

  test("quantization plus withoutEnlargement never upscales a small source", async () => {
    // w=64 snaps up to the smallest allowed width (320), but the source is
    // 200px wide and enlargement is off, so the output stays 200.
    const src = await makeImage(200, 200, "png");
    const out = await engine.optimize({ source: src, transform: { width: 64, format: "webp" } });
    expect(out.width).toBe(200);
  });

  test("is deterministic — identical input, identical etag", async () => {
    const src = await makeImage(400, 400, "png");
    const a = await engine.optimize({ source: src, transform: { width: 320, format: "webp" } });
    const b = await engine.optimize({ source: src, transform: { width: 320, format: "webp" } });
    expect(a.etag).toBe(b.etag);
  });

  test("rejects a non-image", async () => {
    const junk = new TextEncoder().encode("<html>nope</html>");
    await expectCode(() => engine.optimize({ source: junk }), "UNSUPPORTED_FORMAT");
  });
});

describe("engine.plan", () => {
  test("returns a key without doing the work", async () => {
    const src = await makeImage(400, 400, "png");
    const plan = await engine.plan({ source: src, transform: { width: 320, format: "webp" } });
    expect(plan.key).toStartWith("bimg_");
    expect(plan.transform.width).toBe(320);
    expect(plan.sourceInfo).toEqual({ width: 400, height: 400, format: "png" });
  });

  test("equivalent requests plan to the same key", async () => {
    const src = await makeImage(400, 400, "png");
    const identity = { id: "fixed" };
    const a = await engine.plan({ source: src, transform: { width: 320, quality: 75 }, identity });
    const b = await engine.plan({ source: src, transform: { quality: 75, width: 320 }, identity });
    expect(a.key).toBe(b.key);
  });

  test("different transforms plan to different keys", async () => {
    const src = await makeImage(400, 400, "png");
    const identity = { id: "fixed" };
    const a = await engine.plan({ source: src, transform: { width: 320 }, identity });
    const b = await engine.plan({ source: src, transform: { width: 640 }, identity });
    expect(a.key).not.toBe(b.key);
  });

  test("falls back to a content hash when no identity is supplied", async () => {
    const a = await engine.plan({ source: await makeImage(400, 400, "png"), transform: { width: 320 } });
    const b = await engine.plan({ source: await makeImage(401, 400, "png"), transform: { width: 320 } });
    expect(a.key).not.toBe(b.key);
  });
});

describe("engine.placeholder", () => {
  test("returns a ThumbHash data URL", async () => {
    const src = await makeImage(800, 600, "jpeg");
    const p = await engine.placeholder(src);
    expect(p).toStartWith("data:image/png;base64,");
    expect(p.length).toBeLessThan(3000);
  });

  test("is deterministic within a Bun version, so it is safe to cache", async () => {
    const src = await makeImage(800, 600, "jpeg");
    expect(await engine.placeholder(src)).toBe(await engine.placeholder(src));
  });

  test("is independent of any transform — it derives from the source", async () => {
    const src = await makeImage(800, 600, "jpeg");
    const p = await engine.placeholder(src);
    await engine.optimize({ source: src, transform: { width: 320, format: "webp" } });
    expect(await engine.placeholder(src)).toBe(p);
  });
});

describe("engine config", () => {
  test("exposes the resolved config", () => {
    expect(engine.config.defaults.quality).toBe(75);
    expect(engine.config.formats).toEqual(["webp", "jpeg"]);
  });

  test("rejects an empty widths list", () => {
    expect(() => createImageEngine({ widths: [] })).toThrow(TypeError);
  });

  test("rejects an out-of-range quality list", () => {
    expect(() => createImageEngine({ qualities: [0] })).toThrow(TypeError);
    expect(() => createImageEngine({ qualities: [101] })).toThrow(TypeError);
  });

  test("sorts widths regardless of input order", () => {
    const e = createImageEngine({ widths: [1024, 320, 640] });
    expect(e.config.widths).toEqual([320, 640, 1024]);
  });
});

/**
 * The point of `identify`: a warm cache is answered without downloading the
 * source. Before it existed, every request re-fetched the whole body and the
 * cache only saved the encode.
 */
describe("engine.optimize — remote sources", () => {
  const HOST = "images.test";
  const ORIGIN = `http://${HOST}`;

  let server: ReturnType<typeof Bun.serve>;
  let loopback: string;
  let png: Uint8Array;
  let gets = 0;
  let heads = 0;

  beforeAll(async () => {
    png = await makeImage(256, 256, "png");
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const headers = { "content-type": "image/png", etag: '"v1"' };
        if (new URL(request.url).pathname === "/no-validator") {
          return new Response(png, { headers: { "content-type": "image/png" } });
        }
        if (request.method === "HEAD") {
          heads++;
          return new Response(null, { headers });
        }
        gets++;
        return new Response(png, { headers });
      },
    });
    loopback = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => server.stop(true));

  function engineWith(over: Record<string, unknown> = {}, cache = true) {
    return createImageEngine({
      remote: {
        patterns: [{ protocol: "http", hostname: HOST }],
        lookup: async () => [{ address: "93.184.216.34", family: 4 }],
        fetch: (url, init) => fetch(url.replace(ORIGIN, loopback), init),
        ...over,
      },
      ...(cache ? { cache: { memory: { maxSize: "8MB" } } } : {}),
    });
  }

  test("a repeat request hits the cache without downloading the source again", async () => {
    gets = heads = 0;
    const engine = engineWith();
    const src = `${ORIGIN}/a.png`;

    const first = await engine.optimize({ src, transform: { width: 128, format: "png" } });
    const second = await engine.optimize({ src, transform: { width: 128, format: "png" } });

    expect(first.cache).toBe("miss");
    expect(second.cache).toBe("hit");
    expect(gets).toBe(1);
    expect(heads).toBeGreaterThan(0);
  });

  test("a rotated presigned signature still hits the same cache entry", async () => {
    gets = heads = 0;
    const engine = engineWith();
    const base = `${ORIGIN}/signed.png`;

    const first = await engine.optimize({
      src: `${base}?X-Amz-Signature=aaa&X-Amz-Expires=900`,
      transform: { width: 128, format: "png" },
    });
    const second = await engine.optimize({
      src: `${base}?X-Amz-Signature=bbb&X-Amz-Expires=900`,
      transform: { width: 128, format: "png" },
    });

    expect(first.cache).toBe("miss");
    expect(second.cache).toBe("hit");
    expect(first.key).toBe(second.key);
    expect(gets).toBe(1);
  });

  test("a source with no validator still works, by way of the slow path", async () => {
    const engine = engineWith();
    const src = `${ORIGIN}/no-validator`;
    const out = await engine.optimize({ src, transform: { width: 128, format: "png" } });
    // 128 quantizes up to 320, then clamps back to the 256-wide source.
    expect(out.width).toBe(256);
    // No validator, so nothing to key a version on — and `identify` declined,
    // which is what sent this down the slow path in the first place.
    expect(out.sourceVersion).toBeUndefined();
  });

  test("no HEAD is spent when there is no cache to answer from", async () => {
    gets = heads = 0;
    const engine = engineWith({}, false);
    const src = `${ORIGIN}/b.png`;
    await engine.optimize({ src, transform: { width: 128, format: "png" } });
    await engine.optimize({ src, transform: { width: 128, format: "png" } });
    expect(heads).toBe(0);
  });

  test("identify: false falls back to downloading on every request", async () => {
    gets = heads = 0;
    const engine = engineWith({ identify: false });
    const src = `${ORIGIN}/c.png`;
    await engine.optimize({ src, transform: { width: 128, format: "png" } });
    const second = await engine.optimize({ src, transform: { width: 128, format: "png" } });
    expect(second.cache).toBe("hit");
    expect(heads).toBe(0);
    expect(gets).toBe(2);
  });
});
