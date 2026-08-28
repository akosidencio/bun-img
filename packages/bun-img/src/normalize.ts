/**
 * Canonicalization: many spellings in, one transform out.
 *
 * Everything that reaches the cache key goes through here first, so
 * `?w=800&q=75&f=webp` and `?q=75&f=webp&w=800` are the same entry, and so a
 * flood of `w=801, w=802, …` collapses onto the allowed width list instead of
 * filling the cache.
 */
import type { ImageFormat, ImageTransform, NormalizedTransform } from "./types.ts";
import type { ResolvedConfig } from "./config.ts";
import { ImageError } from "./errors.ts";

function badRequest(message: string): never {
  throw new ImageError("INVALID_REQUEST", 400, message);
}

/** Snap up to the smallest allowed width that is >= the request. */
export function quantizeWidth(width: number, cfg: ResolvedConfig): number {
  if (!cfg.quantize) return width;
  const allowed = cfg.widths;
  if (allowed.includes(width)) return width;

  if (cfg.strictWidths) {
    badRequest(`width ${width} is not an allowed width (${allowed.join(", ")})`);
  }

  for (const w of allowed) if (w >= width) return w;
  // Larger than every allowed width: clamp to the largest rather than inventing
  // a new cache entry for an arbitrary number.
  return allowed[allowed.length - 1]!;
}

/** Snap to the nearest allowed quality; ties round up, favouring quality. */
export function quantizeQuality(quality: number, cfg: ResolvedConfig): number {
  if (!cfg.quantize) return quality;
  const allowed = cfg.qualities;
  if (allowed.includes(quality)) return quality;

  if (cfg.strictQualities) {
    badRequest(`quality ${quality} is not an allowed quality (${allowed.join(", ")})`);
  }

  let best = allowed[0]!;
  let bestDistance = Math.abs(best - quality);
  for (const q of allowed) {
    const distance = Math.abs(q - quality);
    if (distance < bestDistance || (distance === bestDistance && q > best)) {
      best = q;
      bestDistance = distance;
    }
  }
  return best;
}

function requireDimension(value: number, name: string, max: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    badRequest(`${name} must be an integer`);
  }
  if (value < 1) badRequest(`${name} must be >= 1`);
  if (value > max) badRequest(`${name} ${value} exceeds the maximum of ${max}`);
  return value;
}

/**
 * Resolve a caller's transform against config and an already-negotiated output
 * format.
 *
 * Negotiation happens before this, not inside it, so that normalization stays a
 * pure function of (request, config, chosen format) and the cache key can never
 * depend on a header that was not folded into the key.
 */
export function normalize(
  transform: ImageTransform,
  cfg: ResolvedConfig,
  negotiated: ImageFormat,
): NormalizedTransform {
  if (transform.quality !== undefined) {
    if (!Number.isInteger(transform.quality)) badRequest("quality must be an integer");
    if (transform.quality < 1 || transform.quality > 100) {
      badRequest("quality must be in 1..100");
    }
  }

  const width =
    transform.width === undefined
      ? null
      : quantizeWidth(requireDimension(transform.width, "width", cfg.limits.maxWidth), cfg);

  const height =
    transform.height === undefined
      ? null
      : requireDimension(transform.height, "height", cfg.limits.maxHeight);

  return Object.freeze({
    width,
    height,
    fit: transform.fit ?? cfg.defaults.fit,
    quality: quantizeQuality(transform.quality ?? cfg.defaults.quality, cfg),
    format: negotiated,
    withoutEnlargement: transform.withoutEnlargement ?? cfg.defaults.withoutEnlargement,
    autoOrient: transform.autoOrient ?? cfg.defaults.autoOrient,
  });
}
