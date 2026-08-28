/**
 * Translating Next's image config into engine config.
 *
 * The important part is **width alignment**, and it is a correctness issue
 * rather than a nicety.
 *
 * `next/image` builds `srcset` from `deviceSizes` and `imageSizes` — it will
 * request exactly those widths and no others. The engine quantizes requests up
 * to its own `widths` list. If the two disagree, every width Next asks for snaps
 * to the next allowed one: the server returns an image *larger* than the markup
 * says it is, the browser scales it down, and each logical width occupies two
 * cache entries instead of one. Nothing errors, so it goes unnoticed.
 *
 * So the engine's widths are derived from Next's lists rather than left to the
 * default, and a mismatch is reported rather than silently reconciled.
 */

/** The subset of `next.config.js` `images` that affects the engine. */
export interface NextImagesConfig {
  deviceSizes?: number[];
  imageSizes?: number[];
  qualities?: number[];
  formats?: string[];
  remotePatterns?: Array<{
    protocol?: string;
    hostname: string;
    port?: string;
    pathname?: string;
  }>;
  minimumCacheTTL?: number;
  loader?: string;
  loaderFile?: string;
  [key: string]: unknown;
}

/** Next's own defaults, for when a project does not override them. */
export const NEXT_DEFAULT_DEVICE_SIZES = [640, 750, 828, 1080, 1200, 1920, 2048, 3840];
export const NEXT_DEFAULT_IMAGE_SIZES = [16, 32, 48, 64, 96, 128, 256, 384];

export interface TranslatedConfig {
  /** Every width `next/image` can request, sorted and de-duplicated. */
  widths: number[];
  qualities: number[];
  remotePatterns: Array<{
    protocol?: "http" | "https";
    hostname: string;
    port?: string;
    pathname?: string;
  }>;
  /** Things worth telling the developer about, rather than papering over. */
  warnings: string[];
}

export function translateNextConfig(images: NextImagesConfig = {}): TranslatedConfig {
  const deviceSizes = images.deviceSizes ?? NEXT_DEFAULT_DEVICE_SIZES;
  const imageSizes = images.imageSizes ?? NEXT_DEFAULT_IMAGE_SIZES;

  // The union is exactly the set of widths next/image can ask for.
  const widths = [...new Set([...deviceSizes, ...imageSizes])].sort((a, b) => a - b);

  const warnings: string[] = [];

  // Next's default quality is 75 and it is not in `qualities` unless listed.
  const qualities = [...new Set(images.qualities ?? [75])].sort((a, b) => a - b);

  const remotePatterns = (images.remotePatterns ?? []).map((pattern) => {
    const protocol = pattern.protocol === "http" ? ("http" as const) : ("https" as const);
    if (pattern.protocol !== undefined && pattern.protocol !== "http" && pattern.protocol !== "https") {
      warnings.push(`remotePattern protocol "${pattern.protocol}" is not supported; using https`);
    }
    return {
      protocol,
      hostname: pattern.hostname,
      ...(pattern.port === undefined || pattern.port === "" ? {} : { port: pattern.port }),
      ...(pattern.pathname === undefined ? {} : { pathname: pattern.pathname }),
    };
  });

  // AVIF encodes nowhere reachable on Linux, so a project configured for it
  // would silently get WebP. Say so at build time rather than at request time.
  if (images.formats?.some((format) => format.includes("avif"))) {
    warnings.push(
      "images.formats requests AVIF, which Bun cannot encode on Linux — " +
        "requests will be served as WebP instead",
    );
  }

  if (images.loader !== undefined && images.loader !== "custom") {
    warnings.push(`images.loader is "${images.loader}"; withBunImage sets it to "custom"`);
  }

  return { widths, qualities, remotePatterns, warnings };
}

/**
 * Check that an engine's width list can serve every width Next will request.
 *
 * Returns the widths that would be quantized up — each one a silently oversized
 * response and a duplicated cache entry.
 */
export function findUnalignedWidths(
  nextWidths: readonly number[],
  engineWidths: readonly number[],
): number[] {
  const allowed = new Set(engineWidths);
  return nextWidths.filter((width) => !allowed.has(width));
}
