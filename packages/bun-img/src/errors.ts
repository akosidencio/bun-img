/**
 * Stable public errors, and the mapping from Bun's error codes onto them.
 *
 * Branch on `error.code`, never on message text — Bun documents the codes as
 * stable and the messages as not.
 */

export type ImageErrorCode =
  | "INVALID_REQUEST"
  | "SOURCE_NOT_ALLOWED"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_TOO_LARGE"
  | "IMAGE_TOO_LARGE"
  | "UNSUPPORTED_FORMAT"
  | "FETCH_TIMEOUT"
  | "FETCH_FAILED"
  | "DECODE_FAILED"
  | "TRANSFORM_FAILED"
  | "ENCODE_FAILED"
  | "QUEUE_FULL"
  | "TRANSFORM_TIMEOUT"
  | "INTERNAL_ERROR";

export class ImageError extends Error {
  override readonly name = "ImageError";

  constructor(
    readonly code: ImageErrorCode,
    readonly status: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Bun error code -> [public code, HTTP status].
 *
 * `ERR_IMAGE_TOO_MANY_PIXELS` also covers the 256 MiB cap on path-backed
 * inputs, so the message must not claim "too many pixels" literally.
 *
 * `EACCES` deliberately maps to 404 rather than 403: a 403 tells an attacker
 * that the path exists but is unreadable, which leaks filesystem topology.
 */
const BUN_TO_PUBLIC: Readonly<Record<string, readonly [ImageErrorCode, number]>> = {
  ERR_IMAGE_UNKNOWN_FORMAT: ["UNSUPPORTED_FORMAT", 415],
  ERR_IMAGE_FORMAT_UNSUPPORTED: ["UNSUPPORTED_FORMAT", 415],
  ERR_IMAGE_TOO_MANY_PIXELS: ["IMAGE_TOO_LARGE", 413],
  ERR_IMAGE_DECODE_FAILED: ["DECODE_FAILED", 422],
  ERR_IMAGE_ENCODE_FAILED: ["ENCODE_FAILED", 500],
  ERR_INVALID_STATE: ["INTERNAL_ERROR", 500],
  ENOENT: ["SOURCE_NOT_FOUND", 404],
  EACCES: ["SOURCE_NOT_FOUND", 404],
  EPERM: ["SOURCE_NOT_FOUND", 404],
  EISDIR: ["SOURCE_NOT_FOUND", 404],
};

const MESSAGES: Readonly<Record<ImageErrorCode, string>> = {
  INVALID_REQUEST: "invalid request",
  SOURCE_NOT_ALLOWED: "source not allowed",
  SOURCE_NOT_FOUND: "source not found",
  SOURCE_TOO_LARGE: "source exceeds the configured size limit",
  IMAGE_TOO_LARGE: "image exceeds the configured pixel or size limit",
  UNSUPPORTED_FORMAT: "unsupported image format",
  FETCH_TIMEOUT: "timed out fetching source",
  FETCH_FAILED: "could not fetch source",
  DECODE_FAILED: "could not decode image",
  TRANSFORM_FAILED: "could not transform image",
  ENCODE_FAILED: "could not encode image",
  QUEUE_FULL: "transform queue saturated",
  TRANSFORM_TIMEOUT: "transform timed out",
  INTERNAL_ERROR: "internal error",
};

function codeOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Translate anything thrown by `Bun.Image` or the filesystem into a stable
 * public error. An `ImageError` passes through untouched so callers can throw
 * their own without it being reclassified.
 */
export function toImageError(err: unknown, fallbackMessage?: string): ImageError {
  if (err instanceof ImageError) return err;

  const bunCode = codeOf(err);
  const mapped = bunCode === undefined ? undefined : BUN_TO_PUBLIC[bunCode];

  if (mapped) {
    const [code, status] = mapped;
    return new ImageError(code, status, MESSAGES[code], { cause: err });
  }

  return new ImageError("INTERNAL_ERROR", 500, fallbackMessage ?? MESSAGES.INTERNAL_ERROR, {
    cause: err,
  });
}

/** Default message for a public code, so call sites need not repeat prose. */
export function messageFor(code: ImageErrorCode): string {
  return MESSAGES[code];
}
