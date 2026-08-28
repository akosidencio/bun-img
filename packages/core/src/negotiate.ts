/**
 * Output format selection.
 *
 * Two rules carry all the weight here, both from Phase 0:
 *
 *  1. **Never assume a codec.** A configured format that this machine cannot
 *     encode is dropped, and an explicitly requested one downgrades rather than
 *     returning a 500.
 *  2. **Never send an alpha source to JPEG.** Bun does not flatten and does not
 *     reject — it drops the alpha channel and keeps whatever RGB happens to sit
 *     underneath, which is arbitrary and varies by source encoder. Measured: a
 *     transparent corner came back as the source colour where Sharp gave black.
 *     Bun has no `flatten` operation to control it, so the only safe route for
 *     an alpha-capable source is PNG (or WebP, which preserves alpha).
 */
import type { Capabilities, DecodeFormat, ImageFormat } from "./types.ts";
import type { ResolvedConfig } from "./config.ts";
import { ImageError } from "./errors.ts";

/** Output formats that can carry an alpha channel. JPEG is the notable absence. */
const ALPHA_SAFE: ReadonlySet<ImageFormat> = new Set<ImageFormat>([
  "png",
  "webp",
  "avif",
  "heic",
]);

/** Container formats that can carry an alpha channel. */
const ALPHA_CAPABLE: ReadonlySet<DecodeFormat> = new Set<DecodeFormat>([
  "png",
  "gif",
  "webp",
  "avif",
  "heic",
  "bmp",
]);

/**
 * Formats a client signals explicitly.
 *
 * Wildcards are deliberately ignored. Browsers send `image/avif,image/webp,
 * image/apng,*​/*;q=0.8`, so honouring `*​/*` would hand WebP to every client
 * including ones that cannot render it. Only explicit `image/<format>` tokens
 * with a non-zero q-value count.
 */
export function parseAccept(accept: string | null | undefined): ReadonlySet<ImageFormat> {
  const wanted = new Set<ImageFormat>();
  if (!accept) return wanted;

  for (const rawPart of accept.split(",")) {
    const [rawType, ...params] = rawPart.split(";");
    const type = rawType?.trim().toLowerCase();
    if (!type || !type.startsWith("image/")) continue;

    // An explicit q=0 is a refusal, not an omission.
    let q = 1;
    for (const param of params) {
      const [k, v] = param.split("=");
      if (k?.trim().toLowerCase() === "q") {
        const parsed = Number.parseFloat(v?.trim() ?? "");
        if (Number.isFinite(parsed)) q = parsed;
      }
    }
    if (q <= 0) continue;

    const subtype = type.slice("image/".length);
    if (subtype === "jpeg" || subtype === "jpg") wanted.add("jpeg");
    else if (subtype === "png") wanted.add("png");
    else if (subtype === "webp") wanted.add("webp");
    else if (subtype === "avif") wanted.add("avif");
    else if (subtype === "heic" || subtype === "heif") wanted.add("heic");
  }
  return wanted;
}

/**
 * The safe passthrough when nothing better is available.
 *
 * Alpha-capable sources go to PNG; everything else to JPEG. If the ideal target
 * is not encodable here, fall through the remaining universally-available
 * formats rather than throwing.
 */
export function fallbackFor(source: DecodeFormat, caps: Capabilities): ImageFormat {
  const preferred: ImageFormat[] = ALPHA_CAPABLE.has(source)
    ? ["png", "webp", "jpeg"]
    : ["jpeg", "webp", "png"];

  for (const format of preferred) {
    if (caps.encode.includes(format)) return format;
  }

  throw new ImageError(
    "UNSUPPORTED_FORMAT",
    500,
    "this runtime cannot encode any image format",
  );
}

export interface NegotiationResult {
  readonly format: ImageFormat;
  /** True when `Accept` influenced the choice — the signal for `Vary: Accept`. */
  readonly negotiated: boolean;
}

export function negotiate(
  requested: "auto" | ImageFormat,
  accept: string | null | undefined,
  sourceFormat: DecodeFormat,
  caps: Capabilities,
  cfg: ResolvedConfig,
): NegotiationResult {
  if (requested !== "auto") {
    if (caps.encode.includes(requested)) {
      // Requesting JPEG for an alpha source is allowed but lossy in a way the
      // caller cannot control; it is their explicit choice, so honour it.
      return { format: requested, negotiated: false };
    }
    if (cfg.onUnsupportedFormat === "reject") {
      throw new ImageError(
        "UNSUPPORTED_FORMAT",
        406,
        `${requested} cannot be encoded on this runtime`,
      );
    }
    return { format: fallbackFor(sourceFormat, caps), negotiated: false };
  }

  const wanted = parseAccept(accept);
  // A source that *may* carry alpha never auto-negotiates to a format that
  // cannot hold it. Bun exposes no `hasAlpha`, so this is decided by container
  // rather than by content — conservative on purpose, because the failure it
  // prevents (silent, source-dependent colour under transparent pixels) is
  // invisible until someone looks at a rendered logo.
  const alphaSource = ALPHA_CAPABLE.has(sourceFormat);

  for (const format of cfg.formats) {
    if (alphaSource && !ALPHA_SAFE.has(format)) continue;
    if (caps.encode.includes(format) && wanted.has(format)) {
      return { format, negotiated: true };
    }
  }

  // No modern format was explicitly accepted. The result does not depend on the
  // Accept header's contents, but it *was* consulted, and a different Accept
  // would have produced a different answer — so this still varies.
  return { format: fallbackFor(sourceFormat, caps), negotiated: true };
}
