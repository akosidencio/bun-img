/**
 * Public type surface.
 *
 * `fit` is deliberately two-valued rather than Sharp's five. Bun offers only
 * `fill` and `inside` and has no `extract` operation, so there is no crop and no
 * `cover` (plan finding R2). The type is the documentation.
 */

/** Formats the engine can *emit*, subject to a runtime capability probe. */
export type ImageFormat = "jpeg" | "png" | "webp" | "avif" | "heic";

/** Formats `Bun.Image` may report from `metadata()`. Decode-only ones included. */
export type DecodeFormat = ImageFormat | "bmp" | "tiff" | "gif";

/**
 * What the runtime can actually do, measured rather than assumed.
 *
 * Phase 0 proved both directions need probing and that they disagree: on macOS
 * AVIF and TIFF decode but never encode, and on Linux they do neither. A probe
 * that ran only on a developer's Mac would report input support the production
 * server does not have.
 */
export interface Capabilities {
  readonly bunVersion: string;
  readonly backend: "system" | "bun";
  readonly platform: string;
  readonly encode: readonly ImageFormat[];
  readonly decode: readonly DecodeFormat[];
}

/** What a caller asks for. Every field optional; defaults come from config. */
export interface ImageTransform {
  width?: number;
  height?: number;
  fit?: "inside" | "fill";
  quality?: number;
  format?: "auto" | ImageFormat;
  withoutEnlargement?: boolean;
  autoOrient?: boolean;
}

/**
 * Fully resolved and canonically ordered. This — and only this — is what the
 * cache key hashes, so two requests that differ in spelling but not in meaning
 * produce the same key.
 */
export interface NormalizedTransform {
  readonly width: number | null;
  readonly height: number | null;
  readonly fit: "inside" | "fill";
  readonly quality: number;
  /** Never `"auto"`: negotiation has already run. */
  readonly format: ImageFormat;
  readonly withoutEnlargement: boolean;
  readonly autoOrient: boolean;
}

/**
 * Stable identity of a source, for cache keying.
 *
 * `version` is an ETag, Last-Modified, or `mtime:size` — anything that changes
 * when the bytes change. When it is absent the engine cannot detect source
 * changes, so the caller must not mark the result `immutable`.
 */
export interface SourceIdentity {
  readonly id: string;
  readonly version?: string;
}

export interface OptimizedImage {
  readonly body: Blob;
  /** Output dimensions, read from the pipeline after the terminal call. */
  readonly width: number;
  readonly height: number;
  readonly format: ImageFormat;
  readonly contentType: string;
  readonly size: number;
  readonly etag: string;
  /**
   * True when the negotiated format depended on the `Accept` header, which is
   * what tells the HTTP layer whether to send `Vary: Accept`.
   */
  readonly negotiated: boolean;
}

/** Source metadata, cached per source identity rather than per transform. */
export interface SourceInfo {
  readonly width: number;
  readonly height: number;
  readonly format: DecodeFormat;
}
