/**
 * The pipeline.
 *
 * Two rules, both learned the hard way in Phase 0:
 *
 *  - **Never inherit a Bun default.** `maxPixels` defaults to 268,402,689 (Sharp
 *    parity, not safety) and resize `fit` defaults to `"fill"` while ours is
 *    `"inside"`. Every option is passed on every call so a future change to
 *    Bun's defaults cannot silently alter our output bytes.
 *  - **Read dimensions after the terminal, never before.** `img.width` is `-1`
 *    until the pipeline runs, and reports *output* dimensions afterwards — so
 *    the result needs no second `metadata()` round-trip.
 */
import type { ImageFormat, NormalizedTransform, SourceInfo } from "./types.ts";
import type { ResolvedConfig } from "./config.ts";
import { ImageError, toImageError } from "./errors.ts";

/** Bytes `Bun.Image` accepts directly. */
export type ImageInput = Uint8Array | ArrayBuffer | Blob;

export interface TransformResult {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

const CONTENT_TYPES: Readonly<Record<ImageFormat, string>> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
};

export function contentTypeFor(format: ImageFormat): string {
  return CONTENT_TYPES[format];
}

/**
 * Wrap encoded bytes in a `Blob`.
 *
 * `new Blob([someUint8Array])` does not typecheck under DOM lib types: there
 * `BlobPart` requires `ArrayBufferView<ArrayBuffer>`, while a `Uint8Array` is
 * generic over `ArrayBufferLike`. The runtime has never minded — only the type
 * does, and only under some `lib` configurations. Since almost every consumer
 * of this package compiles with DOM types, code that builds only under ours is
 * a portability bug rather than a local style question.
 *
 * Narrowed once, here, instead of at each call site. The cast is sound because
 * these bytes always come from `Bun.Image`, never from a `SharedArrayBuffer` —
 * which is the only case the wider type is protecting against.
 */
export function bytesToBlob(bytes: Uint8Array, contentType: string): Blob {
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType });
}

function applyEncoder(img: Bun.Image, format: ImageFormat, quality: number): Bun.Image {
  switch (format) {
    case "jpeg":
      // `progressive` is left off deliberately: it trades a smaller first paint
      // for a larger file, and the engine optimizes for bytes on the wire.
      return img.jpeg({ quality, progressive: false });
    case "png":
      // PNG ignores `quality`; 6 is zlib's default balance of size and time.
      return img.png({ compressionLevel: 6, palette: false });
    case "webp":
      return img.webp({ quality, lossless: false });
    case "avif":
      return img.avif({ quality });
    case "heic":
      return img.heic({ quality });
  }
}

/** Read source dimensions and container format without running a full pipeline. */
export async function readSourceInfo(
  input: ImageInput,
  cfg: ResolvedConfig,
): Promise<SourceInfo> {
  try {
    const md = await new Bun.Image(input, {
      maxPixels: cfg.limits.maxPixels,
      autoOrient: cfg.defaults.autoOrient,
    }).metadata();
    return { width: md.width, height: md.height, format: md.format };
  } catch (err) {
    throw toImageError(err, "could not read image metadata");
  }
}

/**
 * Run one transform.
 *
 * `height`-only requests are resolved to a width before this point, because
 * `Bun.Image.resize` requires a width; passing only a height is not expressible.
 */
export async function runTransform(
  input: ImageInput,
  transform: NormalizedTransform,
  cfg: ResolvedConfig,
): Promise<TransformResult> {
  let img: Bun.Image;
  try {
    img = new Bun.Image(input, {
      maxPixels: cfg.limits.maxPixels,
      autoOrient: transform.autoOrient,
    });

    if (transform.width !== null) {
      img = img.resize(transform.width, transform.height ?? undefined, {
        fit: transform.fit,
        filter: cfg.filter,
        withoutEnlargement: transform.withoutEnlargement,
      });
    }

    img = applyEncoder(img, transform.format, transform.quality);
  } catch (err) {
    throw toImageError(err, "could not build the transform pipeline");
  }

  let bytes: Uint8Array;
  try {
    bytes = await img.bytes();
  } catch (err) {
    throw toImageError(err, "could not run the transform pipeline");
  }

  if (bytes.byteLength > cfg.limits.maxOutputBytes) {
    throw new ImageError(
      "IMAGE_TOO_LARGE",
      413,
      `encoded output is ${bytes.byteLength} bytes, over the ${cfg.limits.maxOutputBytes} limit`,
    );
  }

  // Output dimensions, populated by the awaited terminal above.
  return { bytes, width: img.width, height: img.height };
}

/**
 * A ThumbHash-rendered low-quality placeholder as a `data:` URL.
 *
 * Derived from the *source*, not the transform, so it is independent of width,
 * quality and format — cache it per source identity, not per cache key. It
 * costs a full decode (measured ~188 ms on a 4K JPEG), so caching is not
 * optional. Output is deterministic within a Bun version.
 */
export async function placeholder(input: ImageInput, cfg: ResolvedConfig): Promise<string> {
  try {
    return await new Bun.Image(input, {
      maxPixels: cfg.limits.maxPixels,
      autoOrient: cfg.defaults.autoOrient,
    }).placeholder("dataurl");
  } catch (err) {
    throw toImageError(err, "could not generate a placeholder");
  }
}
