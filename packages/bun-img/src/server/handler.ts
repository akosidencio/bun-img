/**
 * The HTTP endpoint.
 *
 * Web APIs only — `Request` in, `Response` out — so the same handler drops into
 * `Bun.serve`, Hono, Elysia, or an Astro endpoint without adaptation. Framework
 * adapters translate configuration, never the request itself.
 */
import {
  createImageEngine,
  ImageError,
  parseImageRequest,
  type EngineOptions,
  type ImageEngine,
  type OptimizedImage,
} from "../index.ts";
import {
  cacheControlFor,
  etagMatches,
  resolveCachePolicy,
  varyFor,
  type CacheControlPolicy,
} from "./headers.ts";
import {
  classifySource,
  createMetrics,
  redactSource,
  type Hooks,
  type Logger,
  type Metrics,
  type SourceKind,
} from "./observability.ts";

export interface ImageServerOptions extends EngineOptions {
  /** Endpoint prefix. Defaults to `/_image`. */
  path?: string;
  cacheControl?: CacheControlPolicy;
  /**
   * Emit `X-Image-*` diagnostics. Defaults to on outside production — they
   * describe internals, and a production endpoint should not narrate them.
   */
  debugHeaders?: boolean;
  hooks?: Hooks;
  /** Structured logging. Off unless supplied. */
  logger?: Logger;
  /** Reuse an engine instead of building one. */
  engine?: ImageEngine;
}

export interface ImageServer {
  readonly engine: ImageEngine;
  readonly metrics: Metrics;
  readonly path: string;
  handle(request: Request): Promise<Response>;
  /** Shape `Bun.serve({ routes })` expects. */
  readonly handler: (request: Request) => Promise<Response>;
}

const ALLOWED_METHODS = "GET, HEAD, OPTIONS";

export function createImageServer(options: ImageServerOptions = {}): ImageServer {
  const path = options.path ?? "/_image";
  const engine = options.engine ?? createImageEngine(options);
  const policy = resolveCachePolicy(options.cacheControl);
  const metrics = createMetrics();
  const hooks = options.hooks ?? {};
  const logger = options.logger;
  const debugHeaders =
    options.debugHeaders ?? (globalThis.process?.env?.NODE_ENV !== "production");

  function errorResponse(
    error: ImageError,
    method: string,
    durationMs: number,
    sourceKind: SourceKind,
    requestPath: string,
  ): Response {
    const headers = new Headers({
      "content-type": "application/json; charset=utf-8",
    });

    if (error.code === "QUEUE_FULL") {
      // Transient and about *us*, not the content. Caching it would extend a
      // brief saturation spike into minutes of failure for images that are fine.
      headers.set("cache-control", "no-store");
      headers.set("retry-after", "1");
    } else if (error.status >= 500) {
      headers.set("cache-control", "no-store");
    } else {
      // A client-side failure is stable for a while; letting shared caches
      // absorb the repeat is what stops one dead URL on a popular page from
      // becoming sustained load.
      headers.set("cache-control", `public, max-age=${policy.errorMaxAge}`);
    }

    const event = {
      method,
      path: requestPath,
      sourceKind,
      status: error.status,
      durationMs,
      code: error.code,
    };
    metrics.recordError(event);
    hooks.onError?.(event);
    logger?.({
      event: "image.error",
      code: error.code,
      status: error.status,
      source_type: sourceKind,
      path: requestPath,
      duration_ms: Number(durationMs.toFixed(2)),
    });

    const body = method === "HEAD" ? null : JSON.stringify({ error: error.code, message: error.message });
    return new Response(body, { status: error.status, headers });
  }

  function successResponse(
    image: OptimizedImage,
    request: Request,
    durationMs: number,
    sourceKind: SourceKind,
    requestPath: string,
  ): Response {
    const headers = new Headers({
      "content-type": image.contentType,
      "cache-control": cacheControlFor(image, policy),
      etag: image.etag,
    });

    const vary = varyFor(image);
    if (vary) headers.set("vary", vary);

    // Cache provenance is useful in production and reveals nothing: it says
    // whether *we* had the bytes, not anything about the source.
    if (image.cache) headers.set("x-image-cache", image.cache.toUpperCase());

    if (debugHeaders) {
      headers.set("x-image-width", String(image.width));
      headers.set("x-image-height", String(image.height));
      headers.set("x-image-format", image.format);
      headers.set("x-image-source", sourceKind);
      headers.set("x-image-duration", `${durationMs.toFixed(1)}ms`);
    }

    const event = { method: request.method, path: requestPath, sourceKind, status: 200, durationMs, image };
    metrics.record(event);
    if (image.cache === "hit") hooks.onCacheHit?.(event);
    else hooks.onCacheMiss?.(event);
    if (image.cache === "miss") hooks.onTransform?.(event);

    logger?.({
      event: "image.request",
      source_type: sourceKind,
      path: requestPath,
      width: image.width,
      height: image.height,
      format: image.format,
      output_bytes: image.size,
      cache: image.cache ?? "miss",
      duration_ms: Number(durationMs.toFixed(2)),
    });

    // A conditional request that still matches costs nothing beyond the headers
    // we already computed — the cheapest win available at this layer.
    if (etagMatches(request.headers.get("if-none-match"), image.etag)) {
      headers.delete("content-type");
      return new Response(null, { status: 304, headers });
    }

    headers.set("content-length", String(image.size));

    // HEAD must produce identical headers with no body, so a client can size a
    // response without fetching it.
    if (request.method === "HEAD") return new Response(null, { status: 200, headers });

    return new Response(image.body, { status: 200, headers });
  }

  async function handle(request: Request): Promise<Response> {
    const started = performance.now();
    const url = new URL(request.url);
    let sourceKind: SourceKind = "bytes";
    let redactedPath = url.pathname;

    try {
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: { allow: ALLOWED_METHODS, "cache-control": "no-store" },
        });
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(JSON.stringify({ error: "METHOD_NOT_ALLOWED" }), {
          status: 405,
          headers: { allow: ALLOWED_METHODS, "content-type": "application/json; charset=utf-8" },
        });
      }

      const parsed = parseImageRequest(url, { basePath: path });
      sourceKind = classifySource(parsed.source);
      redactedPath = redactSource(parsed.source);

      hooks.onRequest?.({ method: request.method, path: redactedPath, sourceKind });

      const image = await engine.optimize({
        src: parsed.source,
        transform: parsed.transform,
        accept: request.headers.get("accept"),
        signal: request.signal,
      });

      return successResponse(image, request, performance.now() - started, sourceKind, redactedPath);
    } catch (err) {
      const error =
        err instanceof ImageError
          ? err
          : new ImageError("INTERNAL_ERROR", 500, "internal error", { cause: err });
      return errorResponse(error, request.method, performance.now() - started, sourceKind, redactedPath);
    }
  }

  return {
    engine,
    metrics,
    path,
    handle,
    handler: handle,
  };
}
