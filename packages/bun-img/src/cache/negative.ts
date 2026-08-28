/**
 * Negative caching.
 *
 * Without it, a source that 404s becomes an amplifier: every request for a
 * broken image is a fresh upstream fetch, so a page with one dead URL turns the
 * image endpoint into a load generator pointed at the origin. That is
 * self-inflicted, and the spec draft did not mention it.
 *
 * Entries are short-lived and hold only a code and status. The failure has to
 * be *remembered*, not *permanent* — which is exactly why the source-metadata
 * memo in Phase 2 refuses to cache failures at all, and this does it with a TTL
 * instead.
 */
import { ImageError, type ImageErrorCode } from "../errors.ts";

export interface NegativeCacheOptions {
  ttl?: number;
  maxEntries?: number;
}

export interface NegativeEntry {
  readonly code: ImageErrorCode;
  readonly status: number;
  readonly message: string;
  readonly expiresAt: number;
}

export interface NegativeCache {
  get(key: string): NegativeEntry | null;
  set(key: string, error: ImageError): void;
  delete(key: string): void;
  clear(): void;
  readonly size: number;
}

/**
 * Failures worth remembering.
 *
 * Deliberately excluded: `QUEUE_FULL` and the timeouts, which describe *our*
 * load rather than the source, and would otherwise convert a transient
 * saturation spike into a minute of cached failure for content that is fine.
 */
const CACHEABLE: ReadonlySet<ImageErrorCode> = new Set<ImageErrorCode>([
  "SOURCE_NOT_FOUND",
  "SOURCE_NOT_ALLOWED",
  "SOURCE_TOO_LARGE",
  "IMAGE_TOO_LARGE",
  "UNSUPPORTED_FORMAT",
  "DECODE_FAILED",
  "INVALID_REQUEST",
]);

export function isCacheableFailure(error: unknown): error is ImageError {
  return error instanceof ImageError && CACHEABLE.has(error.code);
}

export function negativeCache(options: NegativeCacheOptions = {}): NegativeCache {
  const ttl = options.ttl ?? 60_000;
  const maxEntries = options.maxEntries ?? 10_000;
  const entries = new Map<string, NegativeEntry>();

  return {
    get(key: string): NegativeEntry | null {
      const hit = entries.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= Date.now()) {
        entries.delete(key);
        return null;
      }
      return hit;
    },

    set(key: string, error: ImageError): void {
      if (!CACHEABLE.has(error.code)) return;

      entries.set(key, {
        code: error.code,
        status: error.status,
        message: error.message,
        expiresAt: Date.now() + ttl,
      });

      // Oldest-inserted first. Precise recency is not worth a second structure
      // for entries that expire in a minute anyway.
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },

    delete(key: string): void {
      entries.delete(key);
    },

    clear(): void {
      entries.clear();
    },

    get size(): number {
      return entries.size;
    },
  };
}
