/**
 * Configuration and its defaults.
 *
 * The defaults are chosen to be safe rather than permissive, and several differ
 * deliberately from the spec draft:
 *
 *   - `formats` is WebP-first, not AVIF-first: AVIF encodes nowhere reachable,
 *     and Bun's JPEG costs ~12% more bytes than Sharp's at matched quality, so
 *     JPEG is the compatibility fallback rather than a quality choice.
 *   - Width and quality quantization are **on**. They are the only real defence
 *     against cache-cardinality exhaustion, and signed URLs are post-v1.
 *   - `maxPixels` is always passed to `Bun.Image` explicitly. Its own default is
 *     268,402,689 — Sharp parity, not safety.
 */
import type { ImageFormat } from "./types.ts";

export interface ImageLimits {
  /** Rejected before any pixel buffer is allocated, by Bun itself. */
  maxPixels: number;
  maxWidth: number;
  maxHeight: number;
  maxOutputBytes: number;
}

export interface TransformDefaults {
  quality: number;
  fit: "inside" | "fill";
  autoOrient: boolean;
  withoutEnlargement: boolean;
}

export interface ImageEngineConfig {
  /** Output preference order for `format=auto`. Filtered by the capability probe. */
  formats?: readonly ImageFormat[];
  /** What to do when an explicitly requested format cannot be encoded here. */
  onUnsupportedFormat?: "downgrade" | "reject";
  defaults?: Partial<TransformDefaults>;
  /** Allowed widths. Requests snap up to the next one, or are rejected in strict mode. */
  widths?: readonly number[];
  qualities?: readonly number[];
  /** `false` quantizes out-of-list widths; `true` rejects them. */
  strictWidths?: boolean;
  strictQualities?: boolean;
  limits?: Partial<ImageLimits>;
  /** Resampling kernel. Passed explicitly on every resize. */
  filter?: Bun.Image.Filter;
}

export interface ResolvedConfig {
  readonly formats: readonly ImageFormat[];
  readonly onUnsupportedFormat: "downgrade" | "reject";
  readonly defaults: Readonly<TransformDefaults>;
  readonly widths: readonly number[];
  readonly qualities: readonly number[];
  readonly strictWidths: boolean;
  readonly strictQualities: boolean;
  readonly limits: Readonly<ImageLimits>;
  readonly filter: Bun.Image.Filter;
}

const MB = 1024 * 1024;

export const DEFAULT_WIDTHS: readonly number[] = [320, 480, 640, 768, 1024, 1280, 1536, 1920];
export const DEFAULT_QUALITIES: readonly number[] = [60, 75, 85];

export function resolveConfig(config: ImageEngineConfig = {}): ResolvedConfig {
  const widths = [...(config.widths ?? DEFAULT_WIDTHS)].sort((a, b) => a - b);
  const qualities = [...(config.qualities ?? DEFAULT_QUALITIES)].sort((a, b) => a - b);

  if (widths.length === 0) throw new TypeError("widths must not be empty");
  if (qualities.length === 0) throw new TypeError("qualities must not be empty");
  if (widths.some((w) => !Number.isInteger(w) || w < 1)) {
    throw new TypeError("widths must be positive integers");
  }
  if (qualities.some((q) => !Number.isInteger(q) || q < 1 || q > 100)) {
    throw new TypeError("qualities must be integers in 1..100");
  }

  return Object.freeze({
    formats: Object.freeze([...(config.formats ?? (["webp", "jpeg"] as const))]),
    onUnsupportedFormat: config.onUnsupportedFormat ?? "downgrade",
    defaults: Object.freeze({
      quality: config.defaults?.quality ?? 75,
      fit: config.defaults?.fit ?? "inside",
      autoOrient: config.defaults?.autoOrient ?? true,
      withoutEnlargement: config.defaults?.withoutEnlargement ?? true,
    }),
    widths: Object.freeze(widths),
    qualities: Object.freeze(qualities),
    strictWidths: config.strictWidths ?? false,
    strictQualities: config.strictQualities ?? false,
    limits: Object.freeze({
      maxPixels: config.limits?.maxPixels ?? 40_000_000,
      maxWidth: config.limits?.maxWidth ?? 8192,
      maxHeight: config.limits?.maxHeight ?? 8192,
      maxOutputBytes: config.limits?.maxOutputBytes ?? 20 * MB,
    }),
    filter: config.filter ?? "lanczos3",
  });
}
