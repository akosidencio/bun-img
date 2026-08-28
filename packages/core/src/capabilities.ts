/**
 * Runtime capability probing.
 *
 * Nothing here is inferred from documentation or platform strings. Every entry
 * is the result of actually asking `Bun.Image` to do the thing and catching the
 * rejection, because Phase 0 showed the matrix varies by OS *and* by backend:
 *
 *   - AVIF encodes nowhere reachable (needs an OS AV1 encoder).
 *   - HEIC encodes only on macOS with `backend: "system"`.
 *   - AVIF and TIFF *decode* on macOS but are refused on Linux.
 *   - On Linux, `backend: "system"` changes nothing — there is no OS codec.
 *
 * The probe is one-shot per (backend) and cached, since it costs a handful of
 * tiny encodes and decodes.
 */
import type { Capabilities, DecodeFormat, ImageFormat } from "./types.ts";
import { DECODE_PROBE_SAMPLES } from "./probe-samples.ts";

const ENCODE_CANDIDATES = ["jpeg", "png", "webp", "avif", "heic"] as const;

/** A 2x2 PNG, built at probe time so no PNG constant has to be trusted. */
async function seedPng(): Promise<Uint8Array> {
  // A 1x1 transparent PNG is the smallest thing every build can decode; resize
  // it up so encoders that dislike degenerate dimensions still cooperate.
  const onePx = Uint8Array.from(
    atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
    (c) => c.charCodeAt(0),
  );
  return await new Bun.Image(onePx).resize(2, 2, { fit: "fill" }).png().bytes();
}

function decodeBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function probeEncode(seed: Uint8Array): Promise<ImageFormat[]> {
  const ok: ImageFormat[] = [];
  for (const format of ENCODE_CANDIDATES) {
    try {
      const img = new Bun.Image(seed);
      // Options are always passed explicitly; never rely on a Bun default.
      const encoder =
        format === "jpeg" ? img.jpeg({ quality: 80 })
        : format === "png" ? img.png({ compressionLevel: 6 })
        : format === "webp" ? img.webp({ quality: 80 })
        : format === "avif" ? img.avif({ quality: 50 })
        : img.heic({ quality: 50 });
      const out = await encoder.bytes();
      if (out.byteLength > 0) ok.push(format);
    } catch {
      // An unavailable codec is expected, not exceptional.
    }
  }
  return ok;
}

async function probeDecode(seed: Uint8Array, encodable: readonly ImageFormat[]): Promise<DecodeFormat[]> {
  const ok: DecodeFormat[] = [];

  // Formats we can encode, we can also produce a sample for.
  for (const format of encodable) {
    const sample = await (async () => {
      try {
        const img = new Bun.Image(seed);
        const encoder =
          format === "jpeg" ? img.jpeg({ quality: 80 })
          : format === "png" ? img.png({ compressionLevel: 6 })
          : format === "webp" ? img.webp({ quality: 80 })
          : format === "avif" ? img.avif({ quality: 50 })
          : img.heic({ quality: 50 });
        return await encoder.bytes();
      } catch {
        return null;
      }
    })();
    if (!sample) continue;
    try {
      await new Bun.Image(sample).metadata();
      ok.push(format);
    } catch {
      /* decode unsupported */
    }
  }

  // Formats we cannot encode need a shipped sample.
  for (const [name, b64] of Object.entries(DECODE_PROBE_SAMPLES)) {
    const format = name as DecodeFormat;
    if (ok.includes(format)) continue;
    try {
      await new Bun.Image(decodeBase64(b64)).metadata();
      ok.push(format);
    } catch {
      /* decode unsupported on this platform — the Linux AVIF/TIFF case */
    }
  }

  return ok;
}

const cache = new Map<string, Promise<Capabilities>>();

/**
 * Probe (or return the cached probe for) the current backend.
 *
 * Keyed by backend because `Bun.Image.backend` is process-global and mutable;
 * flipping it changes the answer.
 */
export function capabilities(): Promise<Capabilities> {
  const backend = Bun.Image.backend;
  const cached = cache.get(backend);
  if (cached) return cached;

  const probing = (async (): Promise<Capabilities> => {
    const seed = await seedPng();
    const encode = await probeEncode(seed);
    const decode = await probeDecode(seed, encode);
    return Object.freeze({
      bunVersion: Bun.version,
      backend,
      platform: `${process.platform}/${process.arch}`,
      encode: Object.freeze(encode),
      decode: Object.freeze(decode),
    });
  })();

  cache.set(backend, probing);
  // A failed probe must not be cached as a permanent negative.
  void probing.catch(() => cache.delete(backend));
  return probing;
}

/** Drop the memoized probe. Tests use this; applications should not need it. */
export function resetCapabilities(): void {
  cache.clear();
}
