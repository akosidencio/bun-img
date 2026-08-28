/**
 * The cache contract.
 *
 * Entries store the encoded bytes plus everything needed to serve a response
 * without touching the source again — dimensions, format, ETag. A hit that
 * still had to re-read the original would not be much of a hit.
 */
import type { ImageFormat } from "../types.ts";

export interface CachedImage {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly format: ImageFormat;
  readonly etag: string;
  /** Epoch ms. Used for TTL expiry and as the LRU recency signal on disk. */
  readonly storedAt: number;
  /**
   * Source version at store time, carried through so a caller can tell whether
   * the entry is anchored to a known source state or is TTL-bound.
   */
  readonly sourceVersion?: string;
}

export interface ImageCache {
  readonly name: string;
  get(key: string): Promise<CachedImage | null>;
  set(key: string, image: CachedImage): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  /** Bytes currently held, for metrics and tests. */
  size(): Promise<{ bytes: number; entries: number }>;
}

export type CacheStatus = "hit" | "miss" | "coalesced";
