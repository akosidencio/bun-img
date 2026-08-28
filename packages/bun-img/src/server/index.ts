/**
 * bun-img/server — a Web-standard image endpoint.
 *
 * Depends on core; core depends on nothing. The handler takes a `Request` and
 * returns a `Response`, so it drops into Bun.serve, Hono, Elysia or an Astro
 * endpoint unchanged.
 */

export { createImageServer } from "./handler.ts";
export type { ImageServer, ImageServerOptions } from "./handler.ts";

export {
  cacheControlFor,
  etagMatches,
  resolveCachePolicy,
  varyFor,
} from "./headers.ts";
export type { CacheControlPolicy, ResolvedCacheControlPolicy } from "./headers.ts";

export {
  classifySource,
  consoleLogger,
  createMetrics,
  redactSource,
} from "./observability.ts";
export type {
  ErrorEvent,
  Hooks,
  Logger,
  Metrics,
  MetricsSnapshot,
  RequestEvent,
  ResultEvent,
  SourceKind,
} from "./observability.ts";
