import { describe, expect, test } from "bun:test";
import bunImageLoader, { buildLoaderUrl } from "../../src/next/loader.ts";
import {
  findUnalignedWidths,
  translateNextConfig,
  NEXT_DEFAULT_DEVICE_SIZES,
  NEXT_DEFAULT_IMAGE_SIZES,
} from "../../src/next/config.ts";
import { createNextImageRoute, engineConfigFromNext, withBunImage } from "../../src/next/index.ts";
import { parseImageRequest } from "../../src/index.ts";

describe("loader", () => {
  test("has a default export, which is what Next requires", () => {
    expect(typeof bunImageLoader).toBe("function");
  });

  test("builds an operation-path URL for a local source", () => {
    expect(bunImageLoader({ src: "/hero.jpg", width: 800, quality: 75 })).toBe(
      "/_image/w_800,q_75,f_auto/hero.jpg",
    );
  });

  test("omits quality when Next does not supply one", () => {
    expect(bunImageLoader({ src: "/hero.jpg", width: 800 })).toBe("/_image/w_800,f_auto/hero.jpg");
  });

  test("always emits f_auto, because the loader cannot see Accept", () => {
    // Format depends on the request headers, which only the server sees.
    // Choosing here would mean shipping one format to every client.
    expect(bunImageLoader({ src: "/a.jpg", width: 640 })).toContain("f_auto");
  });

  test("uses the query protocol for remote sources", () => {
    // A full URL cannot be expressed in the operation-path form.
    const url = bunImageLoader({ src: "https://cdn.example.com/a.jpg", width: 640, quality: 80 });
    expect(url).toStartWith("/_image?");
    expect(url).toContain("url=https%3A%2F%2Fcdn.example.com%2Fa.jpg");
  });

  test("encodes path segments but keeps separators", () => {
    expect(buildLoaderUrl({ src: "/a b/c&d.jpg", width: 320 })).toBe(
      "/_image/w_320,f_auto/a%20b/c%26d.jpg",
    );
  });

  test("honours a custom base path", () => {
    expect(buildLoaderUrl({ src: "/a.jpg", width: 320 }, "/img")).toBe("/img/w_320,f_auto/a.jpg");
  });

  test("every URL it produces parses back to the same transform", () => {
    // The loader inlines its URL building rather than importing core, so this
    // is the test that keeps the two implementations from drifting.
    for (const width of [16, 640, 3840]) {
      for (const quality of [undefined, 50, 75]) {
        const url = bunImageLoader({ src: "/photos/a.jpg", width, ...(quality ? { quality } : {}) });
        const parsed = parseImageRequest(url);
        expect(parsed.source).toBe("photos/a.jpg");
        expect(parsed.transform.width).toBe(width);
        expect(parsed.transform.format).toBe("auto");
        if (quality !== undefined) expect(parsed.transform.quality).toBe(quality);
      }
    }
  });

  test("remote URLs it produces also parse back", () => {
    const url = bunImageLoader({ src: "https://cdn.example.com/a.jpg", width: 828 });
    const parsed = parseImageRequest(url);
    expect(parsed.source).toBe("https://cdn.example.com/a.jpg");
    expect(parsed.transform.width).toBe(828);
  });
});

describe("config translation", () => {
  test("derives widths from Next's own lists", () => {
    const { widths } = translateNextConfig({});
    for (const width of [...NEXT_DEFAULT_DEVICE_SIZES, ...NEXT_DEFAULT_IMAGE_SIZES]) {
      expect(widths).toContain(width);
    }
  });

  test("sorts and de-duplicates", () => {
    const { widths } = translateNextConfig({ deviceSizes: [1200, 640], imageSizes: [640, 16] });
    expect(widths).toEqual([16, 640, 1200]);
  });

  test("covers every width next/image can request", () => {
    // The alignment property: if this fails, the server quietly returns images
    // larger than the markup declares and doubles the cache entries.
    const images = { deviceSizes: [640, 1080, 1920], imageSizes: [32, 96] };
    const { widths } = translateNextConfig(images);
    expect(findUnalignedWidths([640, 1080, 1920, 32, 96], widths)).toEqual([]);
  });

  test("findUnalignedWidths names the widths that would be quantized", () => {
    expect(findUnalignedWidths([640, 750, 828], [640, 828])).toEqual([750]);
    expect(findUnalignedWidths([640], [640])).toEqual([]);
  });

  test("defaults quality to Next's 75", () => {
    expect(translateNextConfig({}).qualities).toEqual([75]);
  });

  test("carries remote patterns across", () => {
    const { remotePatterns } = translateNextConfig({
      remotePatterns: [
        { protocol: "https", hostname: "cdn.example.com", pathname: "/products/**" },
        { hostname: "images.example.com" },
      ],
    });
    expect(remotePatterns[0]).toEqual({
      protocol: "https",
      hostname: "cdn.example.com",
      pathname: "/products/**",
    });
    // Next omits protocol meaning https; so does the engine.
    expect(remotePatterns[1]).toEqual({ protocol: "https", hostname: "images.example.com" });
  });

  test("drops an empty port rather than requiring an exact match on it", () => {
    const { remotePatterns } = translateNextConfig({
      remotePatterns: [{ hostname: "a.example.com", port: "" }],
    });
    expect(remotePatterns[0]).not.toHaveProperty("port");
  });

  test("warns that AVIF will not be served, rather than failing at request time", () => {
    const { warnings } = translateNextConfig({ formats: ["image/avif", "image/webp"] });
    expect(warnings.join(" ")).toContain("AVIF");
  });

  test("warns about a conflicting loader setting", () => {
    const { warnings } = translateNextConfig({ loader: "default" });
    expect(warnings.join(" ")).toContain("loader");
  });

  test("produces no warnings for an ordinary config", () => {
    expect(translateNextConfig({ deviceSizes: [640, 1080] }).warnings).toEqual([]);
  });
});

describe("withBunImage", () => {
  test("sets the custom loader and preserves the rest of the config", () => {
    const config = withBunImage(
      { reactStrictMode: true, images: { deviceSizes: [640, 1080] } },
      { warn: false },
    );
    expect(config.reactStrictMode).toBe(true);
    expect(config.images?.loader).toBe("custom");
    expect(config.images?.loaderFile).toBe("./image-loader.ts");
    expect(config.images?.deviceSizes).toEqual([640, 1080]);
  });

  test("honours a custom loaderFile path", () => {
    const config = withBunImage({}, { loaderFile: "./lib/loader.ts", warn: false });
    expect(config.images?.loaderFile).toBe("./lib/loader.ts");
  });

  test("works with no config at all", () => {
    expect(withBunImage(undefined, { warn: false }).images?.loader).toBe("custom");
  });
});

describe("engineConfigFromNext", () => {
  test("yields widths, qualities and remote patterns the engine accepts", () => {
    const config = engineConfigFromNext({
      deviceSizes: [640, 1080],
      imageSizes: [32],
      qualities: [50, 75],
      remotePatterns: [{ hostname: "cdn.example.com" }],
    });
    expect(config.widths).toEqual([32, 640, 1080]);
    expect(config.qualities).toEqual([50, 75]);
    expect(config.remote.patterns[0]?.hostname).toBe("cdn.example.com");
  });
});

describe("createNextImageRoute", () => {
  test("exposes GET and HEAD", () => {
    const route = createNextImageRoute({ nextImages: { deviceSizes: [640] } });
    expect(typeof route.GET).toBe("function");
    expect(typeof route.HEAD).toBe("function");
  });

  test("configures the engine with Next's widths, so nothing is quantized", async () => {
    const route = createNextImageRoute({
      nextImages: { deviceSizes: [640, 1080, 1920], imageSizes: [32] },
    });
    expect(route.server.engine.config.widths).toEqual([32, 640, 1080, 1920]);
  });

  test("serves a URL the loader produced, end to end", async () => {
    const root = new URL("./fixtures/", import.meta.url).pathname;
    const route = createNextImageRoute({
      local: { root },
      nextImages: { deviceSizes: [320, 640], imageSizes: [] },
    });

    const url = bunImageLoader({ src: "/hero.png", width: 320, quality: 75 });
    const response = await route.GET(new Request(`http://localhost${url}`, {
      headers: { accept: "image/webp,image/*" },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    // f_auto means the response varies on Accept.
    expect(response.headers.get("vary")).toBe("Accept");
    expect(response.headers.get("x-image-width")).toBe("320");
  });

  test("a legacy client gets a compatible format from the same URL", async () => {
    const root = new URL("./fixtures/", import.meta.url).pathname;
    const route = createNextImageRoute({
      local: { root },
      nextImages: { deviceSizes: [320], imageSizes: [] },
    });

    const url = bunImageLoader({ src: "/hero.png", width: 320 });
    const response = await route.GET(new Request(`http://localhost${url}`, {
      headers: { accept: "image/jpeg" },
    }));

    expect(response.status).toBe(200);
    // A PNG source never auto-negotiates to JPEG.
    expect(response.headers.get("content-type")).not.toBe("image/jpeg");
  });

  test("explicit options win over the Next-derived ones", () => {
    const route = createNextImageRoute({
      widths: [100, 200],
      nextImages: { deviceSizes: [640, 1080] },
    });
    expect(route.server.engine.config.widths).toEqual([100, 200]);
  });
});
