/**
 * The engine: capability probe, negotiation, normalization, transform.
 *
 * Phase 1 deliberately stops here. There is no cache, no coalescing, no source
 * resolution and no HTTP — `optimize()` takes bytes and returns bytes, so the
 * pipeline can be exercised and tested on its own before any of that exists.
 */
import type {
  Capabilities,
  ImageTransform,
  NormalizedTransform,
  OptimizedImage,
  SourceIdentity,
  SourceInfo,
} from "./types.ts";
import type { ImageEngineConfig, ResolvedConfig } from "./config.ts";
import { resolveConfig } from "./config.ts";
import { capabilities } from "./capabilities.ts";
import { negotiate } from "./negotiate.ts";
import { normalize } from "./normalize.ts";
import { cacheKey, etagFor } from "./cache-key.ts";
import {
  bytesToBlob,
  contentTypeFor,
  placeholder as runPlaceholder,
  readSourceInfo,
  runTransform,
  type ImageInput,
} from "./transform.ts";
import { assertBunImage } from "./guard.ts";
import { ImageError } from "./errors.ts";
import { createLocalResolver, type LocalSourceOptions } from "./sources/local.ts";
import { createRemoteResolver, type RemoteSourceOptions } from "./sources/remote.ts";
import { createSourceRegistry, type SourceRegistry } from "./sources/registry.ts";
import type { ResolvedSource, SourceResolver } from "./sources/types.ts";
import type { CachedImage, CacheStatus, ImageCache } from "./cache/types.ts";
import { nullCache, tieredCache } from "./cache/tiered.ts";
import { memoryCache, type MemoryCacheOptions } from "./cache/memory.ts";
import { diskCache, type DiskCacheOptions } from "./cache/disk.ts";
import {
  isCacheableFailure,
  negativeCache,
  type NegativeCacheOptions,
} from "./cache/negative.ts";
import { createSemaphore, type Semaphore } from "./concurrency/semaphore.ts";
import { createCoalescer } from "./concurrency/coalescer.ts";

export interface OptimizeOptions {
  /**
   * Bytes to transform. Mutually exclusive with `src`.
   *
   * Bypasses source resolution entirely, so no allowlist or containment check
   * applies — only pass bytes you already trust.
   */
  source?: ImageInput;
  /**
   * A source reference to resolve: a path under the local root, or a remote URL
   * matching the configured patterns. This is the path untrusted input takes.
   */
  src?: string;
  transform?: ImageTransform;
  /** Raw `Accept` header, consulted only when `format` is `auto`. */
  accept?: string | null;
  /** Cache identity. Defaults to the resolver's, or a content hash. */
  identity?: SourceIdentity;
  /** Aborts resolution, including the upstream body read. */
  signal?: AbortSignal;
}

export interface CacheConfig {
  memory?: MemoryCacheOptions | false;
  disk?: DiskCacheOptions | false;
  negative?: NegativeCacheOptions | false;
  /** Replaces the built-in tiers entirely. */
  store?: ImageCache;
}

export interface ConcurrencyConfig {
  /** In-flight transforms. Bounds memory and tail latency, not throughput. */
  transforms?: number;
  maxPending?: number;
}

export interface PlanResult {
  readonly transform: NormalizedTransform;
  readonly key: string;
  readonly negotiated: boolean;
  readonly sourceInfo: SourceInfo;
  readonly identity: SourceIdentity;
  /** Absent for byte inputs. `kind` tells the HTTP layer what it is serving. */
  readonly resolved?: ResolvedSource;
}

export interface ImageEngine {
  readonly config: ResolvedConfig;
  readonly sources: SourceRegistry;
  readonly cache: ImageCache;
  readonly semaphore: Semaphore;
  capabilities(): Promise<Capabilities>;
  /** Resolve a request to a normalized transform and cache key without doing work. */
  plan(options: OptimizeOptions): Promise<PlanResult>;
  optimize(options: OptimizeOptions): Promise<OptimizedImage>;
  /** ThumbHash `data:` URL. Cached per source identity, not per transform. */
  placeholder(options: OptimizeOptions | ImageInput): Promise<string>;
  sourceInfo(options: OptimizeOptions | ImageInput): Promise<SourceInfo>;
}

async function toBytes(input: ImageInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(await input.arrayBuffer());
}

/**
 * Height-only requests need a width, because `Bun.Image.resize` cannot express
 * "this tall, aspect preserved". Derive it from the source and let the normal
 * `fit` handling do the rest.
 */
function widthForHeightOnly(info: SourceInfo, height: number): number {
  if (info.height === 0) return info.width;
  return Math.max(1, Math.round((info.width / info.height) * height));
}

export interface EngineOptions extends ImageEngineConfig {
  /** Enable local sources rooted at a directory. */
  local?: LocalSourceOptions;
  /** Enable remote sources. Without patterns, remote stays disabled. */
  remote?: RemoteSourceOptions;
  /** Extra resolvers, tried before the built-ins. */
  resolvers?: readonly SourceResolver[];
  /** Entries in the per-source metadata cache. */
  maxInfoEntries?: number;
  /** Result caching. Off by default, so it is always an explicit choice. */
  cache?: CacheConfig;
  concurrency?: ConcurrencyConfig;
}

/** Default in-flight transforms: bounded by cores, never below 2. */
function defaultTransformLimit(): number {
  const cpus = typeof navigator === "undefined" ? 4 : (navigator.hardwareConcurrency ?? 4);
  return Math.max(2, cpus);
}

function buildCache(config: CacheConfig | undefined): ImageCache {
  if (!config) return nullCache();
  if (config.store) return config.store;

  const tiers: ImageCache[] = [];
  if (config.memory !== false) tiers.push(memoryCache(config.memory ?? {}));
  if (config.disk) tiers.push(diskCache(config.disk));
  return tiers.length === 0 ? nullCache() : tieredCache(tiers);
}

export function createImageEngine(options: EngineOptions = {}): ImageEngine {
  assertBunImage();
  const cfg = resolveConfig(options);

  const builtins: SourceResolver[] = [];
  // Remote first: it claims only absolute http(s) URLs, while the local
  // resolver claims everything that is not an absolute URL.
  if (options.remote) builtins.push(createRemoteResolver(options.remote));
  if (options.local) builtins.push(createLocalResolver(options.local));

  const sources = createSourceRegistry({
    resolvers: [...(options.resolvers ?? []), ...builtins],
    ...(options.maxInfoEntries === undefined ? {} : { maxInfoEntries: options.maxInfoEntries }),
  });

  const cache = buildCache(options.cache);
  const negatives =
    options.cache?.negative === false ? null : negativeCache(options.cache?.negative ?? {});

  const semaphore = createSemaphore({
    limit: options.concurrency?.transforms ?? defaultTransformLimit(),
    ...(options.concurrency?.maxPending === undefined
      ? {}
      : { maxPending: options.concurrency.maxPending }),
  });

  const coalescer = createCoalescer<OptimizedImage>();
  // Keyed by source reference rather than by cache key: a hundred cold requests
  // for one image share one fetch even when they want different widths.
  const sourceCoalescer =
    createCoalescer<{ data: ImageInput; identity: SourceIdentity; resolved?: ResolvedSource }>();

  /** Warn once per process about configured formats this machine cannot encode. */
  let warned = false;
  async function caps(): Promise<Capabilities> {
    const probed = await capabilities();
    if (!warned) {
      warned = true;
      const missing = cfg.formats.filter((f) => !probed.encode.includes(f));
      if (missing.length > 0) {
        console.warn(
          `[bun-img] configured formats not encodable on ${probed.platform} ` +
            `(backend "${probed.backend}"): ${missing.join(", ")} — dropped from negotiation.`,
        );
      }
      if (probed.encode.length === 0) {
        throw new ImageError("UNSUPPORTED_FORMAT", 500, "no image encoder is available");
      }
    }
    return probed;
  }

  /** Turn either input shape into bytes plus an identity. */
  async function acquire(o: OptimizeOptions): Promise<{
    data: ImageInput;
    identity: SourceIdentity;
    resolved?: ResolvedSource;
  }> {
    if (o.src !== undefined && o.source !== undefined) {
      throw new ImageError("INVALID_REQUEST", 400, "pass either src or source, not both");
    }

    if (o.src !== undefined) {
      const resolved = await sources.resolve(o.src, {
        config: cfg,
        ...(o.signal ? { signal: o.signal } : {}),
      });
      return { data: resolved.data, identity: o.identity ?? resolved.identity, resolved };
    }

    if (o.source === undefined) {
      throw new ImageError("INVALID_REQUEST", 400, "no source given");
    }

    if (o.identity) return { data: o.source, identity: o.identity };

    // No identity to key on, so fall back to content addressing.
    const bytes = await toBytes(o.source);
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    return { data: o.source, identity: { id: `sha256:${digest.slice(0, 32)}` } };
  }

  /** Cache key for source-derived facts: identity plus version. */
  const infoKey = (identity: SourceIdentity) => `${identity.id}\u0000${identity.version ?? "-"}`;

  /**
   * Turn a request plus known source facts into a normalized transform.
   *
   * Three call sites need this — `plan()`, the cache fast path, and the slow
   * path — and every one of them has to reach the same answer or the cache key
   * computed on the way in stops matching the one computed on the way out.
   * Keeping it in one place is also what stops a rule like "never auto-negotiate
   * an alpha source to JPEG" from being reintroduced in a copy that drifted.
   */
  function resolveTransform(
    options: OptimizeOptions,
    info: SourceInfo,
    probed: Capabilities,
  ): { transform: NormalizedTransform; negotiated: boolean } {
    const requested = options.transform ?? {};
    const { format, negotiated } = negotiate(
      requested.format ?? "auto",
      options.accept,
      info.format,
      probed,
      cfg,
    );

    const resolved: ImageTransform = { ...requested };
    if (resolved.width === undefined && resolved.height !== undefined) {
      resolved.width = widthForHeightOnly(info, resolved.height);
    }

    return { transform: normalize(resolved, cfg, format), negotiated };
  }

  /** Input formats are capability-gated exactly like output formats. */
  function assertDecodable(info: SourceInfo, probed: Capabilities): void {
    if (!probed.decode.includes(info.format)) {
      throw new ImageError(
        "UNSUPPORTED_FORMAT",
        415,
        `${info.format} sources cannot be decoded on this runtime`,
      );
    }
  }

  async function plan(options: OptimizeOptions): Promise<PlanResult> {
    const probed = await caps();
    const acquired = await acquire(options);
    const info = await sources.info(infoKey(acquired.identity), () =>
      readSourceInfo(acquired.data, cfg),
    );

    assertDecodable(info, probed);
    const { transform, negotiated } = resolveTransform(options, info, probed);

    return {
      transform,
      key: cacheKey(acquired.identity, transform, probed),
      negotiated,
      sourceInfo: info,
      identity: acquired.identity,
      ...(acquired.resolved ? { resolved: acquired.resolved } : {}),
    };
  }

  return {
    config: cfg,
    capabilities: caps,
    cache,
    semaphore,
    plan,

    async optimize(options: OptimizeOptions): Promise<OptimizedImage> {
      /**
       * Two levels of coalescing, because there are two expensive things to
       * avoid duplicating and they have different keys:
       *
       *   - **acquisition**, keyed by the source reference. A hundred cold
       *     requests for one image must produce one fetch, not a hundred.
       *   - **transformation**, keyed by the cache key. Requests that differ
       *     only in width share a source but not an output.
       *
       * Ordering matters: source resolution has to happen *inside* the
       * coalescing, not before it. Resolving first and coalescing after would
       * make every concurrent request pay for its own fetch, which is the
       * herd this exists to prevent.
       */
      const sourceKey = options.src === undefined ? null : `src:${options.src}`;

      // A remembered resolution failure short-circuits before anything else, so
      // one dead URL on a page cannot turn this endpoint into a load generator
      // aimed at the origin.
      if (sourceKey) {
        const remembered = negatives?.get(sourceKey);
        if (remembered) {
          throw new ImageError(remembered.code, remembered.status, remembered.message);
        }
      }

      const acquireOnce = async () => {
        if (!sourceKey) return await acquire(options);
        try {
          const { value } = await sourceCoalescer.run(sourceKey, () => acquire(options));
          return value;
        } catch (err) {
          if (isCacheableFailure(err)) negatives?.set(sourceKey, err);
          throw err;
        }
      };

      const fromCached = (hit: CachedImage, key: string, negotiated: boolean, status: CacheStatus) => {
        const contentType = contentTypeFor(hit.format);
        return Object.freeze({
          body: bytesToBlob(hit.bytes, contentType),
          width: hit.width,
          height: hit.height,
          format: hit.format,
          contentType,
          size: hit.bytes.byteLength,
          etag: hit.etag,
          negotiated,
          cache: status,
          key,
          ...(hit.sourceVersion === undefined ? {} : { sourceVersion: hit.sourceVersion }),
        });
      };

      /**
       * Resolve a request to a key without opening the source.
       *
       * Needs the source identity (a `stat`) and its container format (from the
       * per-source memo the first request populated). With both, every later
       * transform of that image is answerable from cache with no I/O at all.
       */
      async function planFromCache(): Promise<
        { key: string; transform: NormalizedTransform; negotiated: boolean } | null
      > {
        if (options.src === undefined) return null;

        const identity = await sources.identify(options.src, {
          config: cfg,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!identity) return null;

        const info = await sources.peekInfo(infoKey(identity));
        if (!info) return null;

        const probed = await caps();
        const { transform, negotiated } = resolveTransform(options, info, probed);
        return { key: cacheKey(identity, transform, probed), transform, negotiated };
      }

      /** Cache re-check, transform under the semaphore, then store. */
      const produce = async (
        key: string,
        transform: NormalizedTransform,
        negotiated: boolean,
        getData: () => Promise<{ data: ImageInput; version: string | undefined }>,
      ): Promise<OptimizedImage> => {
        const remembered = negatives?.get(key);
        if (remembered) {
          throw new ImageError(remembered.code, remembered.status, remembered.message);
        }

        const { value, coalesced } = await coalescer.run(key, async () => {
          // Another request may have finished this exact work while we queued.
          const late = await cache.get(key);
          if (late) return fromCached(late, key, negotiated, "hit");

          const { data, version } = await getData();

          let result;
          try {
            // The semaphore sits *inside* the coalescer, so N concurrent
            // requests for one image occupy one slot rather than N. Nested the
            // other way round, a popular image would fill the queue by itself.
            result = await semaphore.run(() => runTransform(data, transform, cfg));
          } catch (err) {
            if (isCacheableFailure(err)) negatives?.set(key, err);
            throw err;
          }

          const contentType = contentTypeFor(transform.format);
          const etag = etagFor(result.bytes);

          await cache.set(key, {
            bytes: result.bytes,
            width: result.width,
            height: result.height,
            format: transform.format,
            etag,
            storedAt: Date.now(),
            ...(version === undefined ? {} : { sourceVersion: version }),
          });

          return Object.freeze({
            body: bytesToBlob(result.bytes, contentType),
            width: result.width,
            height: result.height,
            format: transform.format,
            contentType,
            size: result.bytes.byteLength,
            etag,
            negotiated,
            cache: "miss" as CacheStatus,
            key,
            ...(version === undefined ? {} : { sourceVersion: version }),
          });
        });

        // Followers get the leader's bytes and their own provenance label.
        return coalesced && value.cache === "miss"
          ? Object.freeze({ ...value, cache: "coalesced" as CacheStatus })
          : value;
      };

      // ── fast path: key known without touching the source ────────────────
      const planned = await planFromCache();
      if (planned) {
        const hit = await cache.get(planned.key);
        if (hit) return fromCached(hit, planned.key, planned.negotiated, "hit");

        return await produce(planned.key, planned.transform, planned.negotiated, async () => {
          const acquired = await acquireOnce();
          return { data: acquired.data, version: acquired.identity.version };
        });
      }

      // ── slow path: the source has to be read before its key is knowable ──
      const acquired = await acquireOnce();
      const probed = await caps();
      const info = await sources.info(infoKey(acquired.identity), () =>
        readSourceInfo(acquired.data, cfg),
      );

      assertDecodable(info, probed);
      const { transform, negotiated } = resolveTransform(options, info, probed);
      const key = cacheKey(acquired.identity, transform, probed);

      return await produce(key, transform, negotiated, async () => ({
        data: acquired.data,
        version: acquired.identity.version,
      }));
    },

    sources,

    async placeholder(input: OptimizeOptions | ImageInput): Promise<string> {
      const o = normalizeInput(input);
      const acquired = await acquire(o);
      return await sources.placeholder(infoKey(acquired.identity), () =>
        runPlaceholder(acquired.data, cfg),
      );
    },

    async sourceInfo(input: OptimizeOptions | ImageInput): Promise<SourceInfo> {
      const o = normalizeInput(input);
      const acquired = await acquire(o);
      return await sources.info(infoKey(acquired.identity), () =>
        readSourceInfo(acquired.data, cfg),
      );
    },
  };
}

/** Accept either the options object or bare bytes, for ergonomics. */
function normalizeInput(input: OptimizeOptions | ImageInput): OptimizeOptions {
  if (
    input instanceof Uint8Array ||
    input instanceof ArrayBuffer ||
    input instanceof Blob
  ) {
    return { source: input };
  }
  return input;
}
