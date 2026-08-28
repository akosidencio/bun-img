/**
 * bun-img/next — point `next/image` at a bun-img endpoint.
 *
 * Two halves that have to agree:
 *
 *   1. `withBunImage()` wraps `next.config` so `next/image` generates bun-img
 *      URLs instead of calling Next's own optimizer.
 *   2. `createNextImageRoute()` mounts the endpoint that serves them.
 *
 * They agree on width lists, which is the part most likely to go quietly wrong:
 * `next/image` requests widths from `deviceSizes`/`imageSizes`, and the engine
 * quantizes to its own list. `engineConfigFromNext()` derives one from the other
 * so the two cannot drift.
 */
import { createImageServer, type ImageServerOptions } from "../server/index.ts";
import {
  findUnalignedWidths,
  translateNextConfig,
  type NextImagesConfig,
  type TranslatedConfig,
} from "./config.ts";

export { buildLoaderUrl, default as bunImageLoader } from "./loader.ts";
export type { NextLoaderParams } from "./loader.ts";
export {
  findUnalignedWidths,
  translateNextConfig,
  NEXT_DEFAULT_DEVICE_SIZES,
  NEXT_DEFAULT_IMAGE_SIZES,
} from "./config.ts";
export type { NextImagesConfig, TranslatedConfig } from "./config.ts";

/** Loosely typed so this package never has to import `next`. */
export interface NextConfigLike {
  images?: NextImagesConfig;
  [key: string]: unknown;
}

export interface WithBunImageOptions {
  /** Endpoint prefix. Must match the route you mount. Defaults to `/_image`. */
  path?: string;
  /**
   * Path to the loader module, as Next resolves it — relative to the project
   * root, e.g. `"./image-loader.ts"`.
   *
   * Next requires a file path here, not a package specifier, and it reads the
   * file at build time. The default assumes you re-export ours:
   *
   * ```ts
   * // image-loader.ts
   * export { default } from "../next/loader.ts";
   * ```
   */
  loaderFile?: string;
  /** Print translation warnings at config time. Default true. */
  warn?: boolean;
}

/**
 * Wrap a Next config so `next/image` routes through bun-img.
 *
 * Application code does not change: `<Image src="/hero.jpg" width={1200} … />`
 * keeps working, and only the transformation backend moves.
 */
export function withBunImage(
  nextConfig: NextConfigLike = {},
  options: WithBunImageOptions = {},
): NextConfigLike {
  const translated = translateNextConfig(nextConfig.images);

  if (options.warn !== false) {
    for (const warning of translated.warnings) {
      console.warn(`[bun-img] ${warning}`);
    }
  }

  return {
    ...nextConfig,
    images: {
      ...nextConfig.images,
      loader: "custom",
      loaderFile: options.loaderFile ?? "./image-loader.ts",
    },
  };
}

/**
 * Engine config matching a Next config.
 *
 * Use this where the endpoint is created, so the server allows exactly the
 * widths, qualities and remote hosts that `next/image` will ask for.
 */
export function engineConfigFromNext(images: NextImagesConfig = {}): {
  widths: number[];
  qualities: number[];
  remote: { patterns: TranslatedConfig["remotePatterns"] };
} {
  const translated = translateNextConfig(images);
  return {
    widths: translated.widths,
    qualities: translated.qualities,
    remote: { patterns: translated.remotePatterns },
  };
}

export interface NextImageRouteOptions extends ImageServerOptions {
  /** The `images` block from `next.config`, for width and host alignment. */
  nextImages?: NextImagesConfig;
}

/**
 * A route handler for the App Router.
 *
 * ```ts
 * // app/_image/[[...path]]/route.ts
 * import { createNextImageRoute } from "bun-img/next";
 * import nextConfig from "../../../next.config";
 *
 * export const { GET, HEAD } = createNextImageRoute({
 *   local: { root: "./public" },
 *   nextImages: nextConfig.images,
 * });
 * ```
 */
export function createNextImageRoute(options: NextImageRouteOptions = {}) {
  const { nextImages, ...serverOptions } = options;

  /**
   * The engine is built on the first request, never at module scope.
   *
   * `next build` evaluates route modules in a **Node** worker to collect page
   * data. Constructing the engine there trips the `Bun.Image` runtime guard and
   * fails the build — even though the same code runs fine when the server is
   * actually serving. Deferring construction keeps the build working and costs
   * one lazy initialization on the first request.
   */
  let instance: ReturnType<typeof createImageServer> | null = null;

  function server() {
    if (instance) return instance;

    const derived = nextImages ? engineConfigFromNext(nextImages) : undefined;
    instance = createImageServer({
      ...serverOptions,
      ...(derived
        ? {
            widths: serverOptions.widths ?? derived.widths,
            qualities: serverOptions.qualities ?? derived.qualities,
            remote: serverOptions.remote ?? derived.remote,
          }
        : {}),
    });

    // Surface a width mismatch loudly on first use. Left alone it produces
    // images larger than the markup declares and doubles the cache entries,
    // with nothing in the response to indicate it.
    if (nextImages) {
      const unaligned = findUnalignedWidths(
        engineConfigFromNext(nextImages).widths,
        instance.engine.config.widths,
      );
      if (unaligned.length > 0) {
        console.warn(
          `[bun-img] next/image will request widths the engine does not allow: ` +
            `${unaligned.join(", ")}. They will be quantized up, so responses will be ` +
            `larger than the markup declares. Align images.deviceSizes/imageSizes with ` +
            `the engine's widths, or drop the explicit widths option.`,
        );
      }
    }

    return instance;
  }

  const handler = (request: Request) => server().handle(request);

  return {
    GET: handler,
    HEAD: handler,
    /** Forces construction. Tests use it; route handlers should not need to. */
    get server() {
      return server();
    },
  };
}
