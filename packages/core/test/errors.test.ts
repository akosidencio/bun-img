import { describe, expect, test } from "bun:test";
import { ImageError, messageFor, toImageError } from "../src/errors.ts";

/** A stand-in for a rejection from Bun.Image, which carries a `code`. */
function bunError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Image: ${code} happened`), { code });
}

describe("ImageError", () => {
  test("carries a code and an HTTP status", () => {
    const err = new ImageError("INVALID_REQUEST", 400, "bad");
    expect(err.code).toBe("INVALID_REQUEST");
    expect(err.status).toBe(400);
    expect(err.name).toBe("ImageError");
    expect(err).toBeInstanceOf(Error);
  });

  test("preserves a cause", () => {
    const cause = new Error("root");
    expect(new ImageError("INTERNAL_ERROR", 500, "x", { cause }).cause).toBe(cause);
  });
});

describe("toImageError", () => {
  test("maps every documented Bun error code", () => {
    const expected: Array<[string, string, number]> = [
      ["ERR_IMAGE_UNKNOWN_FORMAT", "UNSUPPORTED_FORMAT", 415],
      ["ERR_IMAGE_FORMAT_UNSUPPORTED", "UNSUPPORTED_FORMAT", 415],
      ["ERR_IMAGE_TOO_MANY_PIXELS", "IMAGE_TOO_LARGE", 413],
      ["ERR_IMAGE_DECODE_FAILED", "DECODE_FAILED", 422],
      ["ERR_IMAGE_ENCODE_FAILED", "ENCODE_FAILED", 500],
      ["ERR_INVALID_STATE", "INTERNAL_ERROR", 500],
    ];
    for (const [bun, code, status] of expected) {
      const mapped = toImageError(bunError(bun));
      expect(mapped.code).toBe(code as never);
      expect(mapped.status).toBe(status);
    }
  });

  test("maps filesystem codes", () => {
    for (const code of ["ENOENT", "EACCES", "EPERM", "EISDIR"]) {
      expect(toImageError(bunError(code)).code).toBe("SOURCE_NOT_FOUND");
    }
  });

  test("does not leak filesystem topology through EACCES", () => {
    // A 403 would confirm the path exists but is unreadable.
    const mapped = toImageError(bunError("EACCES"));
    expect(mapped.status).toBe(404);
  });

  test("passes an ImageError through unchanged", () => {
    const original = new ImageError("QUEUE_FULL", 503, "full");
    expect(toImageError(original)).toBe(original);
  });

  test("falls back to INTERNAL_ERROR for an unknown code", () => {
    const mapped = toImageError(bunError("ERR_SOMETHING_NEW"));
    expect(mapped.code).toBe("INTERNAL_ERROR");
    expect(mapped.status).toBe(500);
  });

  test("handles values that are not errors at all", () => {
    for (const thrown of [null, undefined, "boom", 42, {}, []]) {
      const mapped = toImageError(thrown);
      expect(mapped).toBeInstanceOf(ImageError);
      expect(mapped.code).toBe("INTERNAL_ERROR");
    }
  });

  test("attaches the original as the cause", () => {
    const original = bunError("ERR_IMAGE_DECODE_FAILED");
    expect(toImageError(original).cause).toBe(original);
  });

  test("does not surface Bun's message text to callers", () => {
    // ERR_IMAGE_TOO_MANY_PIXELS also covers the 256 MiB path-input cap, so
    // repeating Bun's wording would sometimes be wrong.
    const mapped = toImageError(bunError("ERR_IMAGE_TOO_MANY_PIXELS"));
    expect(mapped.message).not.toContain("ERR_IMAGE");
    expect(mapped.message).toBe(messageFor("IMAGE_TOO_LARGE"));
  });

  test("uses a supplied fallback message for unmapped errors", () => {
    expect(toImageError(new Error("x"), "custom text").message).toBe("custom text");
  });
});

describe("messageFor", () => {
  test("returns prose for every code", () => {
    const codes = [
      "INVALID_REQUEST", "SOURCE_NOT_ALLOWED", "SOURCE_NOT_FOUND", "SOURCE_TOO_LARGE",
      "IMAGE_TOO_LARGE", "UNSUPPORTED_FORMAT", "FETCH_TIMEOUT", "FETCH_FAILED",
      "DECODE_FAILED", "TRANSFORM_FAILED", "ENCODE_FAILED", "QUEUE_FULL",
      "TRANSFORM_TIMEOUT", "INTERNAL_ERROR",
    ] as const;
    for (const code of codes) {
      expect(messageFor(code).length).toBeGreaterThan(0);
    }
  });
});
