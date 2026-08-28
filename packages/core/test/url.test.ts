import { describe, expect, test } from "bun:test";
import {
  imageQueryUrl,
  imageUrl,
  parseImageRequest,
  srcset,
} from "../src/url/index.ts";
import type { ImageTransform } from "../src/types.ts";
import { expectCode } from "./helpers.ts";

describe("imageUrl", () => {
  test("emits the comma form in canonical order", () => {
    expect(imageUrl("/hero.jpg", { quality: 75, width: 800, format: "webp" })).toBe(
      "/_image/w_800,q_75,f_webp/hero.jpg",
    );
  });

  test("emits no ops segment when the transform is empty", () => {
    expect(imageUrl("/hero.jpg")).toBe("/_image/hero.jpg");
  });

  test("accepts a source with or without a leading slash", () => {
    expect(imageUrl("hero.jpg", { width: 320 })).toBe(imageUrl("/hero.jpg", { width: 320 }));
  });

  test("honours a custom basePath", () => {
    expect(imageUrl("/a.jpg", { width: 320 }, { basePath: "/img" })).toBe("/img/w_320/a.jpg");
    expect(imageUrl("/a.jpg", { width: 320 }, { basePath: "/img/" })).toBe("/img/w_320/a.jpg");
  });

  test("percent-encodes each path segment but keeps separators", () => {
    expect(imageUrl("/a b/c&d.jpg", { width: 320 })).toBe("/_image/w_320/a%20b/c%26d.jpg");
  });

  test("inverts withoutEnlargement into the readable enlarge flag", () => {
    expect(imageUrl("/a.jpg", { withoutEnlargement: false })).toBe("/_image/enlarge_1/a.jpg");
    expect(imageUrl("/a.jpg", { withoutEnlargement: true })).toBe("/_image/enlarge_0/a.jpg");
  });

  test("rejects an empty source", async () => {
    await expectCode(() => imageUrl(""), "INVALID_REQUEST");
  });
});

describe("imageQueryUrl", () => {
  test("puts the source in url and ops in params", () => {
    expect(imageQueryUrl("/hero.jpg", { width: 800, quality: 75 })).toBe(
      "/_image?url=%2Fhero.jpg&w=800&q=75",
    );
  });

  test("round-trips a remote source, which the path form cannot carry", () => {
    const url = imageQueryUrl("https://cdn.example.com/a.jpg", { width: 640 });
    const parsed = parseImageRequest(url);
    expect(parsed.source).toBe("https://cdn.example.com/a.jpg");
    expect(parsed.transform.width).toBe(640);
  });
});

describe("parseImageRequest — path protocol", () => {
  test("parses the comma form", () => {
    const r = parseImageRequest("/_image/w_800,q_75,f_webp/hero.jpg");
    expect(r.protocol).toBe("path");
    expect(r.source).toBe("hero.jpg");
    expect(r.transform).toEqual({ width: 800, quality: 75, format: "webp" });
  });

  test("parses the segment form identically", () => {
    const comma = parseImageRequest("/_image/w_800,q_75,f_webp/hero.jpg");
    const segments = parseImageRequest("/_image/w_800/q_75/f_webp/hero.jpg");
    expect(segments.transform).toEqual(comma.transform);
    expect(segments.source).toBe(comma.source);
  });

  test("parses a mixed comma and segment form", () => {
    const r = parseImageRequest("/_image/w_800,q_75/f_webp/hero.jpg");
    expect(r.transform).toEqual({ width: 800, quality: 75, format: "webp" });
  });

  test("keeps nested source paths intact", () => {
    const r = parseImageRequest("/_image/w_800/images/2026/hero.jpg");
    expect(r.source).toBe("images/2026/hero.jpg");
  });

  test("works with no operations at all", () => {
    const r = parseImageRequest("/_image/hero.jpg");
    expect(r.source).toBe("hero.jpg");
    expect(r.transform).toEqual({});
  });

  test("treats a lone op-shaped segment as the source, not an operation", () => {
    // `/_image/w_800.jpg` is a file called w_800.jpg.
    const r = parseImageRequest("/_image/w_800.jpg");
    expect(r.source).toBe("w_800.jpg");
    expect(r.transform).toEqual({});
  });

  test("treats an unknown key_value segment as source, not a bad operation", () => {
    // A directory called `my_photos` must not become a 400.
    const r = parseImageRequest("/_image/w_320/my_photos/a.jpg");
    expect(r.source).toBe("my_photos/a.jpg");
    expect(r.transform).toEqual({ width: 320 });
  });

  test("decodes percent-encoded source segments", () => {
    const r = parseImageRequest("/_image/w_320/a%20b/c%26d.jpg");
    expect(r.source).toBe("a b/c&d.jpg");
  });

  test("parses every operation", () => {
    const r = parseImageRequest(
      "/_image/w_800,h_600,fit_fill,q_85,f_png,enlarge_1,orient_0/a.jpg",
    );
    expect(r.transform).toEqual({
      width: 800,
      height: 600,
      fit: "fill",
      quality: 85,
      format: "png",
      withoutEnlargement: false,
      autoOrient: false,
    });
  });

  describe("rejects malformed requests", () => {
    const cases: Array<[string, string]> = [
      ["duplicate op across segments", "/_image/w_800/w_640/a.jpg"],
      ["duplicate op within a segment", "/_image/w_800,w_640/a.jpg"],
      ["non-numeric width", "/_image/w_abc/a.jpg"],
      ["signed width", "/_image/w_+800/a.jpg"],
      ["fractional width", "/_image/w_80.5/a.jpg"],
      ["unknown format", "/_image/f_bmp/a.jpg"],
      ["bad fit", "/_image/fit_cover/a.jpg"],
      ["bad boolean", "/_image/orient_yes/a.jpg"],
      ["empty op value", "/_image/w_/a.jpg"],
      ["wrong base path", "/other/w_800/a.jpg"],
      ["no source", "/_image/"],
    ];
    for (const [name, url] of cases) {
      test(name, async () => {
        await expectCode(() => parseImageRequest(url), "INVALID_REQUEST");
      });
    }
  });
});

describe("parseImageRequest — query protocol", () => {
  test("parses url and ops", () => {
    const r = parseImageRequest("/_image?url=/hero.jpg&w=800&q=75&f=webp");
    expect(r.protocol).toBe("query");
    expect(r.source).toBe("/hero.jpg");
    expect(r.transform).toEqual({ width: 800, quality: 75, format: "webp" });
  });

  test("is order-independent", () => {
    const a = parseImageRequest("/_image?url=/h.jpg&w=800&q=75&f=webp");
    const b = parseImageRequest("/_image?q=75&f=webp&url=/h.jpg&w=800");
    expect(a.transform).toEqual(b.transform);
  });

  test("tolerates a trailing slash on the base path", () => {
    expect(parseImageRequest("/_image/?url=/h.jpg&w=320").source).toBe("/h.jpg");
  });

  describe("rejects malformed requests", () => {
    const cases: Array<[string, string]> = [
      ["missing url", "/_image?w=800"],
      ["empty url", "/_image?url=&w=800"],
      ["repeated parameter", "/_image?url=/a.jpg&w=800&w=640"],
      ["unknown parameter", "/_image?url=/a.jpg&width=800"],
      ["bad value", "/_image?url=/a.jpg&q=high"],
    ];
    for (const [name, url] of cases) {
      test(name, async () => {
        await expectCode(() => parseImageRequest(url), "INVALID_REQUEST");
      });
    }
  });
});

describe("round-trip property", () => {
  const widths = [undefined, 1, 320, 813, 8192];
  const heights = [undefined, 240];
  const qualities = [undefined, 1, 75, 100];
  const formats = [undefined, "auto", "webp", "jpeg", "png", "avif", "heic"] as const;
  const fits = [undefined, "inside", "fill"] as const;
  const flags = [undefined, true, false];

  const transforms: ImageTransform[] = [];
  for (const width of widths)
    for (const height of heights)
      for (const quality of qualities)
        for (const format of formats)
          for (const fit of fits)
            for (const withoutEnlargement of flags) {
              const t: ImageTransform = {};
              if (width !== undefined) t.width = width;
              if (height !== undefined) t.height = height;
              if (quality !== undefined) t.quality = quality;
              if (format !== undefined) t.format = format;
              if (fit !== undefined) t.fit = fit;
              if (withoutEnlargement !== undefined) t.withoutEnlargement = withoutEnlargement;
              transforms.push(t);
            }

  test(`path protocol round-trips ${transforms.length} transforms exactly`, () => {
    for (const t of transforms) {
      const parsed = parseImageRequest(imageUrl("/hero.jpg", t));
      expect(parsed.transform).toEqual(t);
      expect(parsed.source).toBe("hero.jpg");
    }
  });

  test(`query protocol round-trips the same ${transforms.length} transforms`, () => {
    for (const t of transforms) {
      const parsed = parseImageRequest(imageQueryUrl("/hero.jpg", t));
      expect(parsed.transform).toEqual(t);
      expect(parsed.source).toBe("/hero.jpg");
    }
  });

  test("both protocols agree on the parsed transform", () => {
    for (const t of transforms) {
      const viaPath = parseImageRequest(imageUrl("/hero.jpg", t)).transform;
      const viaQuery = parseImageRequest(imageQueryUrl("/hero.jpg", t)).transform;
      expect(viaPath).toEqual(viaQuery);
    }
  });

  test("source paths survive a round trip", () => {
    const sources = ["hero.jpg", "a/b/c.png", "a b.jpg", "a&b.jpg", "ünïcodé.jpg", "a,b.jpg"];
    for (const source of sources) {
      expect(parseImageRequest(imageUrl(source, { width: 320 })).source).toBe(source);
    }
  });
});

describe("srcset", () => {
  test("builds src, srcset and sizes", () => {
    const r = srcset("/hero.jpg", { widths: [320, 640, 1280] });
    expect(r.src).toBe("/_image/w_1280/hero.jpg");
    expect(r.srcset).toBe(
      "/_image/w_320/hero.jpg 320w, /_image/w_640/hero.jpg 640w, /_image/w_1280/hero.jpg 1280w",
    );
    expect(r.sizes).toBe("100vw");
    expect(r.width).toBe(1280);
  });

  test("points src at the largest width so non-srcset clients are not shortchanged", () => {
    expect(srcset("/a.jpg", { widths: [1280, 320] }).src).toBe("/_image/w_1280/a.jpg");
  });

  test("sorts and de-duplicates widths", () => {
    const r = srcset("/a.jpg", { widths: [640, 320, 640] });
    expect(r.srcset).toBe("/_image/w_320/a.jpg 320w, /_image/w_640/a.jpg 640w");
  });

  test("applies a shared transform to every entry", () => {
    const r = srcset("/a.jpg", { widths: [320], transform: { quality: 85, format: "webp" } });
    expect(r.srcset).toBe("/_image/w_320,q_85,f_webp/a.jpg 320w");
  });

  test("honours custom sizes and basePath", () => {
    const r = srcset("/a.jpg", { widths: [320], sizes: "50vw", basePath: "/img" });
    expect(r.sizes).toBe("50vw");
    expect(r.src).toBe("/img/w_320/a.jpg");
  });

  test("every generated URL parses back", () => {
    const r = srcset("/a/b.jpg", { widths: [320, 640], transform: { format: "webp" } });
    for (const entry of r.srcset.split(", ")) {
      const [url, descriptor] = entry.split(" ");
      const parsed = parseImageRequest(url!);
      expect(parsed.source).toBe("a/b.jpg");
      expect(`${parsed.transform.width}w`).toBe(descriptor!);
    }
  });

  test("rejects empty or invalid widths", async () => {
    await expectCode(() => srcset("/a.jpg", { widths: [] }), "INVALID_REQUEST");
    await expectCode(() => srcset("/a.jpg", { widths: [0] }), "INVALID_REQUEST");
    await expectCode(() => srcset("/a.jpg", { widths: [1.5] }), "INVALID_REQUEST");
  });
});
