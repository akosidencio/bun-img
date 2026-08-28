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

  async function plan(options: OptimizeOptions): Promise<PlanResult> {
    const probed = await caps();
    const acquired = await acquire(options);
    const info = await sources.info(infoKey(acquired.identity), () =>
      readSourceInfo(acquired.data, cfg),
    );

    if (!probed.decode.includes(info.format)) {
      // The Linux case: AVIF and TIFF sources decode on macOS and are refused
      // here, so input support is capability-gated exactly like output.
      throw new ImageError(
        "UNSUPPORTED_FORMAT",
        415,
        `${info.format} sources cannot be decoded on this runtime`,
      );
    }

    const requested = options.transform ?? {};
    const { format, negotiated } = negotiate(
      requested.format ?? "auto",
      options.accept,
      info.format,
      probed,
      cfg,
    );

    const resolvedTransform: ImageTransform = { ...requested };
    if (resolvedTransform.width === undefined && resolvedTransform.height !== undefined) {
      resolvedTransform.width = widthForHeightOnly(info, resolvedTransform.height);
    }

    const transform = normalize(resolvedTransform, cfg, format);

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
    plan,

    async optimize(options: OptimizeOptions): Promise<OptimizedImage> {
      const planned = await plan(options);
      // Reuse the bytes the plan already fetched — re-resolving would double
      // every upstream request.
      const data = planned.resolved?.data ?? options.source!;
      const { transform, negotiated } = planned;
      const result = await runTransform(data, transform, cfg);
      const contentType = contentTypeFor(transform.format);

      return Object.freeze({
        body: new Blob([result.bytes], { type: contentType }),
        width: result.width,
        height: result.height,
        format: transform.format,
        contentType,
        size: result.bytes.byteLength,
        etag: etagFor(result.bytes),
        negotiated,
      });
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
