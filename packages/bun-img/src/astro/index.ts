/**
 * An Astro **local image service**.
 *
 * This is the adapter that actually proves the engine is framework-agnostic.
 * Astro hands `transform()` a `Uint8Array` and expects bytes back — no HTTP, no
 * source resolution, no URL protocol in between. Everything the Next adapter
 * reaches through the server, this reaches directly.
 *
 * ```ts
 * // astro.config.mjs
 * export default defineConfig({
 *   image: { service: { entrypoint: "bun-img/astro" } },
 * });
 * ```
 *
 * `<Image />` and `<Picture />` from `astro:assets` keep working unchanged;
 * only the transformation backend moves.
 *
 * The types here mirror Astro's `LocalImageService` structurally rather than
 * importing it, so this package never depends on `astro`.
 */
import { createImageEngine, type ImageEngine } from "../engine.ts";
import type { ImageEngineConfig } from "../config.ts";
import type { ImageFormat } from "../types.ts";
import { ImageError } from "../errors.ts";

/** Astro's `VALID_OUTPUT_FORMATS`, minus the ones Bun cannot encode. */
const ASTRO_TO_ENGINE: Readonly<Record<string, ImageFormat>> = {
  webp: "webp",
  png: "png",
  jpeg: "jpeg",
  jpg: "jpeg",
  avif: "avif",
};

/** Astro accepts named quality presets as well as numbers. */
const QUALITY_PRESETS: Readonly<Record<string, number>> = {
  low: 40,
  mid: 60,
  high: 80,
  max: 95,
};

export interface AstroImageTransform {
  src: unknown;
  width?: number | `${number}`;
  height?: number | `${number}`;
  format?: string;
  quality?: number | `${number}` | string;
  fit?: string;
  [key: string]: unknown;
}

export interface AstroLocalTransform {
  src: string;
  [key: string]: unknown;
}

export interface BunImageServiceConfig extends ImageEngineConfig {
  /** Endpoint Astro routes image requests through. Astro's default is `/_image`. */
  endpoint?: string;
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : undefined;
}

/**
 * Astro's `src` is either a string or an imported `ImageMetadata` object.
 * Only the string form survives a URL round trip, which is what the endpoint
 * needs.
 */
function srcOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "src" in value) {
    const inner = (value as { src: unknown }).src;
    if (typeof inner === "string") return inner;
  }
  throw new ImageError("INVALID_REQUEST", 400, "image src must be a string or an imported image");
}

function resolveQuality(value: unknown): number | undefined {
  if (typeof value === "string" && value in QUALITY_PRESETS) return QUALITY_PRESETS[value];
  return toNumber(value);
}

/**
 * Astro's `fit` vocabulary is CSS `object-fit`, which is wider than Bun's.
 *
 * `cover`, `none` and `scale-down` have no equivalent — Bun offers only `fill`
 * and `inside`, and has no crop at all. Rather than silently substituting
 * something that distorts the image, the unsupported values map to the nearest
 * non-destructive behaviour and say so once.
 */
let warnedAboutFit = false;
function resolveFit(value: unknown): "inside" | "fill" | undefined {
  if (value === undefined) return undefined;
  if (value === "fill") return "fill";
  if (value === "contain" || value === "inside") return "inside";

  if (!warnedAboutFit) {
    warnedAboutFit = true;
    console.warn(
      `[bun-img] astro fit="${String(value)}" has no equivalent: Bun offers only ` +
        `"fill" and "inside" and cannot crop. Falling back to "inside" — pair it with ` +
        `CSS object-fit if you need cropping.`,
    );
  }
  return "inside";
}

export function createBunImageService(config: BunImageServiceConfig = {}) {
  const endpoint = config.endpoint ?? "/_image";
  let engine: ImageEngine | null = null;

  /**
   * Built on first use, never at module load.
   *
   * Astro imports the service entrypoint while loading its config — in a
   * context that may not be Bun — and constructing the engine there would trip
   * the `Bun.Image` guard before any image is ever requested. The same lesson
   * the Next adapter learned from `next build`.
   */
  const getEngine = (): ImageEngine =>
    (engine ??= createImageEngine({
      /**
       * Width and quality quantization is off unless the caller asks for it.
       *
       * Astro emits the author's declared width straight into the markup —
       * `<Image width={300} />` becomes `width="300"` — and separately asks us
       * for the bytes. Snapping 300 up to the nearest allowed width would make
       * the attribute disagree with the file, which is a layout bug that no
       * error would ever surface.
       *
       * Quantization exists to bound cache cardinality on a *public* endpoint.
       * Astro owns its own URL space and hashes each transform to a file, so
       * that pressure does not apply here.
       */
      quantize: false,
      ...config,
    }));

  return {
    /**
     * Which properties change the output, and therefore the cache filename.
     * Astro hashes these; omitting one would make two different images collide.
     */
    propertiesToHash: ["src", "width", "height", "format", "quality", "fit"],

    validateOptions(options: AstroImageTransform): AstroImageTransform {
      const format = options.format;
      if (format !== undefined && !(format in ASTRO_TO_ENGINE)) {
        throw new ImageError(
          "UNSUPPORTED_FORMAT",
          400,
          `format "${format}" is not supported; use webp, png, jpeg or avif`,
        );
      }

      // Astro's default output format is webp, which is also the one format
      // that both encodes everywhere and is worth defaulting to.
      return { ...options, format: format ?? "webp" };
    },

    getURL(options: AstroImageTransform): string {
      const params = new URLSearchParams();
      params.set("href", srcOf(options.src));

      const width = toNumber(options.width);
      const height = toNumber(options.height);
      const quality = resolveQuality(options.quality);
      const fit = resolveFit(options.fit);

      if (width !== undefined) params.set("w", String(width));
      if (height !== undefined) params.set("h", String(height));
      if (quality !== undefined) params.set("q", String(quality));
      if (options.format !== undefined) params.set("f", String(options.format));
      if (fit !== undefined) params.set("fit", fit);

      return `${endpoint}?${params.toString()}`;
    },

    parseURL(url: URL): AstroLocalTransform | undefined {
      const href = url.searchParams.get("href");
      if (href === null) return undefined;

      const transform: AstroLocalTransform = { src: href };
      for (const [param, key] of [
        ["w", "width"],
        ["h", "height"],
        ["q", "quality"],
        ["f", "format"],
        ["fit", "fit"],
      ] as const) {
        const value = url.searchParams.get(param);
        if (value !== null) transform[key] = value;
      }
      return transform;
    },

    getHTMLAttributes(options: AstroImageTransform): Record<string, unknown> {
      const {
        src, width, height, format, quality, fit,
        // Astro's own directives. They shape which variants get generated, and
        // are not HTML attributes — leaving them in `rest` renders
        // `widths="320,640,900"` onto the tag.
        widths, densities, formats, fallbackFormat, pictureAttributes, inferSize, priority,
        ...rest
      } = options;
      void src; void format; void quality; void fit;
      void widths; void densities; void formats; void fallbackFormat;
      void pictureAttributes; void inferSize; void priority;

      return {
        ...rest,
        width: toNumber(width),
        height: toNumber(height),
        // Defaults that prevent layout shift and keep decoding off the main
        // thread; a caller can override either through `rest`.
        loading: rest.loading ?? "lazy",
        decoding: rest.decoding ?? "async",
      };
    },

    /**
     * Variants for `srcset`.
     *
     * Optional in Astro's interface, but `<Picture>` and the `widths` /
     * `densities` props are silently useless without it: Astro renders
     * `<source srcset>` with nothing in it and falls back to the unresized
     * original. Implementing it is what makes responsive images work at all.
     */
    getSrcSet(options: AstroImageTransform): Array<{
      transform: AstroImageTransform;
      descriptor?: string;
      attributes?: Record<string, unknown>;
    }> {
      const widths = Array.isArray(options.widths) ? (options.widths as unknown[]) : undefined;
      const densities = Array.isArray(options.densities) ? (options.densities as unknown[]) : undefined;

      if (widths) {
        return widths
          .map((raw) => toNumber(raw))
          .filter((width): width is number => width !== undefined)
          .map((width) => ({
            transform: { ...options, width },
            descriptor: `${width}w`,
          }));
      }

      if (densities) {
        // A density multiplies the declared width, so it needs one to scale.
        const base = toNumber(options.width);
        if (base === undefined) return [];

        return densities
          .map((raw) => {
            const value = typeof raw === "string" ? Number(raw.replace(/x$/i, "")) : Number(raw);
            return Number.isFinite(value) && value > 0 ? value : undefined;
          })
          .filter((density): density is number => density !== undefined)
          .map((density) => ({
            transform: { ...options, width: Math.round(base * density) },
            descriptor: `${density}x`,
          }));
      }

      return [];
    },

    /**
     * The engine boundary: bytes in, bytes out.
     *
     * No HTTP, no source resolver, no cache key — Astro owns all of that and
     * has already read the file. This is the whole adapter surface that the
     * core has to satisfy, and it satisfies it without knowing Astro exists.
     */
    async transform(
      inputBuffer: Uint8Array,
      transform: AstroLocalTransform,
    ): Promise<{ data: Uint8Array; format: string }> {
      const requested = typeof transform.format === "string" ? transform.format : "webp";
      const format = ASTRO_TO_ENGINE[requested] ?? "webp";

      const width = toNumber(transform.width);
      const height = toNumber(transform.height);
      const quality = resolveQuality(transform.quality);
      const fit = resolveFit(transform.fit);

      const result = await getEngine().optimize({
        source: inputBuffer,
        transform: {
          ...(width === undefined ? {} : { width }),
          ...(height === undefined ? {} : { height }),
          ...(quality === undefined ? {} : { quality }),
          ...(fit === undefined ? {} : { fit }),
          format,
        },
      });

      return {
        data: new Uint8Array(await result.body.arrayBuffer()),
        // The engine may have downgraded — AVIF encodes nowhere on Linux — so
        // report what was actually produced rather than what was asked for.
        format: result.format === "jpeg" ? "jpeg" : result.format,
      };
    },
  };
}

/**
 * The default export Astro loads from `service.entrypoint`.
 *
 * Astro imports the entrypoint and uses its default export directly, so the
 * service has to exist as a value here rather than behind a factory call.
 * Per-project configuration goes through `image.service.config`, which reaches
 * the engine because the service reads it lazily on first use.
 */
const service = createBunImageService();
export default service;
