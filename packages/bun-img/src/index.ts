/**
 * bun-img — Bun-native image transformation. No Sharp, no libvips.
 *
 * Zero dependencies, by design and by test: framework adapters depend on core,
 * never the other way round.
 */

export { createImageEngine } from "./engine.ts";
export type {
  CacheConfig,
  ConcurrencyConfig,
  EngineOptions,
  ImageEngine,
  OptimizeOptions,
  PlanResult,
} from "./engine.ts";

export { capabilities, resetCapabilities } from "./capabilities.ts";
export { resolveConfig, DEFAULT_WIDTHS, DEFAULT_QUALITIES } from "./config.ts";
export type {
  ImageEngineConfig,
  ImageLimits,
  ResolvedConfig,
  TransformDefaults,
} from "./config.ts";

export { ImageError, toImageError, messageFor } from "./errors.ts";
export type { ImageErrorCode } from "./errors.ts";

export { normalize, quantizeQuality, quantizeWidth } from "./normalize.ts";
export { fallbackFor, negotiate, parseAccept } from "./negotiate.ts";
export type { NegotiationResult } from "./negotiate.ts";

export { cacheKey, canonicalString, etagFor, KEY_SCHEMA } from "./cache-key.ts";

export { bytesToBlob, contentTypeFor, placeholder, readSourceInfo, runTransform } from "./transform.ts";
export type { ImageInput, TransformResult } from "./transform.ts";

export { assertBunImage } from "./guard.ts";

export { memoryCache } from "./cache/memory.ts";
export type { MemoryCacheOptions } from "./cache/memory.ts";
export { diskCache } from "./cache/disk.ts";
export type { DiskCacheOptions } from "./cache/disk.ts";
export { nullCache, tieredCache } from "./cache/tiered.ts";
export { isCacheableFailure, negativeCache } from "./cache/negative.ts";
export type { NegativeCache, NegativeCacheOptions, NegativeEntry } from "./cache/negative.ts";
export { formatSize, parseSize } from "./cache/size.ts";
export type { CachedImage, CacheStatus, ImageCache } from "./cache/types.ts";

export { createSemaphore } from "./concurrency/semaphore.ts";
export type { Semaphore, SemaphoreOptions, SemaphoreStats } from "./concurrency/semaphore.ts";
export { createCoalescer } from "./concurrency/coalescer.ts";
export type { Coalescer, CoalescerStats } from "./concurrency/coalescer.ts";

export { createLocalResolver } from "./sources/local.ts";
export type { LocalSourceOptions } from "./sources/local.ts";
export { createRemoteResolver, readCapped } from "./sources/remote.ts";
export type { RemoteSourceOptions, LookupFn, FetchFn } from "./sources/remote.ts";
export { createSourceRegistry } from "./sources/registry.ts";
export type { SourceRegistry, SourceRegistryOptions } from "./sources/registry.ts";
export {
  matchHostname,
  matchPathname,
  matchesAnyPattern,
  matchesPattern,
} from "./sources/patterns.ts";
export type { RemotePattern } from "./sources/patterns.ts";
export { classifyIp, hostnameVerdict, isIpLiteral } from "./sources/ip.ts";
export type { IpVerdict } from "./sources/ip.ts";
export type { ResolveContext, ResolvedSource, SourceResolver } from "./sources/types.ts";

export {
  imageQueryUrl,
  imageUrl,
  parseImageRequest,
  srcset,
  OP_ORDER,
} from "./url/index.ts";
export type {
  ParsedImageRequest,
  Srcset,
  SrcsetOptions,
  UrlOptions,
  OpKey,
} from "./url/index.ts";

export type {
  Capabilities,
  DecodeFormat,
  ImageFormat,
  ImageTransform,
  NormalizedTransform,
  OptimizedImage,
  SourceIdentity,
  SourceInfo,
} from "./types.ts";
