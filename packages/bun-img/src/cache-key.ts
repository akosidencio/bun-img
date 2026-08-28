/**
 * Cache keys.
 *
 * The key includes `Bun.Image.backend` and the Bun version, which the spec draft
 * omitted. Measured, the two backends produce different output bytes for every
 * fixture tested — the pixels are near-identical (SSIM 0.99923, imperceptible),
 * but the files are not, and a cache shared between a macOS dev box and a Linux
 * production box would hand back entries the running backend would never have
 * produced. That is a coherence bug, not a cosmetic one.
 */
import type { Capabilities, NormalizedTransform, SourceIdentity } from "./types.ts";

/** Bump when the canonical string's shape changes, to orphan old entries. */
export const KEY_SCHEMA = 1;

/**
 * Field separator. NUL cannot occur in a path, an ETag, or any enum here, so no
 * field value can impersonate a delimiter — `{id: "a b", version: "c"}` and
 * `{id: "a", version: "b c"}` must not collide.
 */
const SEP = "\u0000";

/**
 * The exact string that gets hashed.
 *
 * Exposed because a key mismatch is far easier to debug by diffing two of these
 * than by diffing two hashes.
 */
export function canonicalString(
  source: SourceIdentity,
  transform: NormalizedTransform,
  caps: Capabilities,
): string {
  return [
    `s${KEY_SCHEMA}`,
    caps.bunVersion,
    caps.backend,
    source.id,
    // Prefixed so an absent version cannot be forged by a source whose version
    // is literally the placeholder.
    source.version === undefined ? "-" : `v${source.version}`,
    transform.width ?? "-",
    transform.height ?? "-",
    transform.fit,
    transform.quality,
    transform.format,
    transform.withoutEnlargement ? 1 : 0,
    transform.autoOrient ? 1 : 0,
  ].join(SEP);
}

export function cacheKey(
  source: SourceIdentity,
  transform: NormalizedTransform,
  caps: Capabilities,
): string {
  const digest = new Bun.CryptoHasher("sha256")
    .update(canonicalString(source, transform, caps))
    .digest("hex");
  return `bimg_${digest.slice(0, 32)}`;
}

/**
 * A strong ETag over the response bytes.
 *
 * Derived from the output rather than the key so that two keys which happen to
 * produce identical bytes also produce identical ETags, and so a client's
 * `If-None-Match` stays valid across a key-schema bump.
 */
export function etagFor(bytes: Uint8Array): string {
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  return `"bimg_${digest.slice(0, 32)}"`;
}
