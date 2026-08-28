/**
 * Response header policy.
 *
 * Three rules here are corrections to the spec draft, and each of them is the
 * difference between a CDN caching this well and caching it badly.
 */
import type { OptimizedImage } from "../index.ts";

export interface CacheControlPolicy {
  /** Seconds, for sources whose version is known. Default one year. */
  immutableMaxAge?: number;
  /** Seconds, for sources with no validator. Default one hour. */
  revalidateMaxAge?: number;
  /** Seconds of `stale-while-revalidate` on unversioned responses. */
  staleWhileRevalidate?: number;
  /** Seconds a client may cache an error. Default 60. */
  errorMaxAge?: number;
}

export interface ResolvedCacheControlPolicy {
  readonly immutableMaxAge: number;
  readonly revalidateMaxAge: number;
  readonly staleWhileRevalidate: number;
  readonly errorMaxAge: number;
}

export function resolveCachePolicy(policy: CacheControlPolicy = {}): ResolvedCacheControlPolicy {
  return {
    immutableMaxAge: policy.immutableMaxAge ?? 31_536_000,
    revalidateMaxAge: policy.revalidateMaxAge ?? 3_600,
    staleWhileRevalidate: policy.staleWhileRevalidate ?? 86_400,
    errorMaxAge: policy.errorMaxAge ?? 60,
  };
}

/**
 * `immutable` is a promise that the bytes at this URL will never change. It is
 * only honest when the engine can detect a source change — which means the
 * source had a validator (an ETag, a Last-Modified, an mtime) folded into the
 * cache key.
 *
 * Without one, the same URL can legitimately start returning different bytes,
 * and `immutable` would pin the old ones in shared caches for a year with no
 * way to flush them. Those responses get a bounded TTL plus
 * `stale-while-revalidate` instead.
 */
export function cacheControlFor(
  image: OptimizedImage,
  policy: ResolvedCacheControlPolicy,
): string {
  if (image.sourceVersion !== undefined) {
    return `public, max-age=${policy.immutableMaxAge}, immutable`;
  }
  return (
    `public, max-age=${policy.revalidateMaxAge}, ` +
    `stale-while-revalidate=${policy.staleWhileRevalidate}`
  );
}

/**
 * `Vary: Accept` only when `Accept` actually chose the format.
 *
 * The spec draft sent it on every response, alongside `immutable`. That
 * combination fragments a CDN's cache by a high-entropy header — Chrome, Safari
 * and Firefox all send different `Accept` strings, and each variant becomes its
 * own stored object — while simultaneously telling the CDN to keep them all for
 * a year. An explicit `f=webp` URL is content-addressed and does not vary at
 * all, so it gets no `Vary` and one cache entry.
 */
export function varyFor(image: OptimizedImage): string | null {
  return image.negotiated ? "Accept" : null;
}

/**
 * Weak comparison, per RFC 9110 §8.8.3.2 — the correct one for `If-None-Match`.
 *
 * `W/"abc"` and `"abc"` are a match for the purpose of a conditional GET: they
 * denote semantically equivalent representations, and refusing the 304 would
 * make every revalidation re-download bytes the client already holds.
 */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;

  const candidate = ifNoneMatch.trim();
  if (candidate === "*") return true;

  const normalize = (raw: string) => {
    const trimmed = raw.trim();
    return trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
  };

  const target = normalize(etag);
  return candidate.split(",").some((part) => normalize(part) === target);
}
