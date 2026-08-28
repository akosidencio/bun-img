/**
 * Test fixtures built with `Bun.Image` itself.
 *
 * Core has zero dependencies and its tests keep that property: no Sharp, no
 * checked-in binaries beyond one 1x1 PNG seed. Everything else is synthesized.
 */
import type { Capabilities, ImageFormat } from "../src/types.ts";

/** 1x1 opaque PNG. */
const SEED_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

/** A solid image of exactly `width` x `height` in the requested format. */
export async function makeImage(
  width: number,
  height: number,
  format: ImageFormat = "png",
): Promise<Uint8Array> {
  const img = new Bun.Image(SEED_PNG).resize(width, height, { fit: "fill" });
  switch (format) {
    case "jpeg":
      return await img.jpeg({ quality: 90 }).bytes();
    case "webp":
      return await img.webp({ quality: 90 }).bytes();
    case "avif":
      return await img.avif({ quality: 60 }).bytes();
    case "heic":
      return await img.heic({ quality: 60 }).bytes();
    case "png":
      return await img.png({ compressionLevel: 1 }).bytes();
  }
}

/** Capabilities object for tests that must not depend on the host machine. */
export function fakeCaps(over: Partial<Capabilities> = {}): Capabilities {
  return Object.freeze({
    bunVersion: "1.4.0",
    backend: "bun" as const,
    platform: "linux/x64",
    encode: ["jpeg", "png", "webp"] as const,
    decode: ["jpeg", "png", "webp", "gif"] as const,
    ...over,
  }) as Capabilities;
}

/** Assert that a promise rejects with a specific `ImageError.code`. */
export async function expectCode(fn: () => unknown, code: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const actual = (err as { code?: unknown }).code;
    if (actual !== code) {
      throw new Error(`expected error code ${code}, got ${String(actual)}: ${String(err)}`);
    }
    return;
  }
  throw new Error(`expected a rejection with code ${code}, but it resolved`);
}
