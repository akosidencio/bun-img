/**
 * Hooks, metrics and structured logs.
 *
 * The spec's §34 warning — "avoid high-cardinality labels such as full source
 * URLs" — is enforced here rather than left to the caller. A metrics label
 * taken from user-controlled input is an unbounded series count, which is how a
 * monitoring system gets taken down by the thing it is monitoring. Sources are
 * labelled by *kind*, never by URL.
 *
 * The same reasoning applies to logs: §35 says not to log signed URLs or
 * sensitive query parameters, so a URL is redacted to its path before it is
 * written anywhere.
 */
import type { ImageErrorCode, OptimizedImage } from "../index.ts";

export type SourceKind = "local" | "remote" | "bytes";

export interface RequestEvent {
  readonly method: string;
  readonly path: string;
  readonly sourceKind: SourceKind;
}

export interface ResultEvent extends RequestEvent {
  readonly status: number;
  readonly durationMs: number;
  readonly image?: OptimizedImage;
}

export interface ErrorEvent extends RequestEvent {
  readonly status: number;
  readonly durationMs: number;
  readonly code: ImageErrorCode;
}

export interface Hooks {
  onRequest?(event: RequestEvent): void;
  onCacheHit?(event: ResultEvent): void;
  onCacheMiss?(event: ResultEvent): void;
  onTransform?(event: ResultEvent): void;
  onError?(event: ErrorEvent): void;
}

export interface MetricsSnapshot {
  readonly requestsTotal: number;
  readonly cacheHitsTotal: number;
  readonly cacheMissesTotal: number;
  readonly coalescedTotal: number;
  readonly errorsTotal: Readonly<Record<string, number>>;
  readonly outputBytesTotal: number;
  readonly byFormat: Readonly<Record<string, number>>;
  readonly bySourceKind: Readonly<Record<string, number>>;
  readonly transformDurationMs: {
    readonly count: number;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
  };
}

export interface Metrics {
  record(event: ResultEvent): void;
  recordError(event: ErrorEvent): void;
  snapshot(): MetricsSnapshot;
  reset(): void;
}

/**
 * A bounded reservoir of recent durations.
 *
 * Keeping every sample would be an unbounded array — a slow memory leak in a
 * process that is supposed to run for weeks, and the spec's P0 is explicitly
 * about not growing under sustained load.
 */
const RESERVOIR = 1024;

export function createMetrics(): Metrics {
  let requestsTotal = 0;
  let cacheHitsTotal = 0;
  let cacheMissesTotal = 0;
  let coalescedTotal = 0;
  let outputBytesTotal = 0;
  const errorsTotal: Record<string, number> = {};
  const byFormat: Record<string, number> = {};
  const bySourceKind: Record<string, number> = {};
  const durations: number[] = [];
  let durationCursor = 0;
  let durationCount = 0;

  const quantile = (sorted: number[], q: number) => {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return sorted[index]!;
  };

  return {
    record(event: ResultEvent): void {
      requestsTotal++;
      bySourceKind[event.sourceKind] = (bySourceKind[event.sourceKind] ?? 0) + 1;

      const image = event.image;
      if (!image) return;

      if (image.cache === "hit") cacheHitsTotal++;
      else if (image.cache === "coalesced") coalescedTotal++;
      else cacheMissesTotal++;

      byFormat[image.format] = (byFormat[image.format] ?? 0) + 1;
      outputBytesTotal += image.size;

      // Only real work is timed; a cache hit would drag every percentile toward
      // zero and hide the latency that actually matters.
      if (image.cache === "miss") {
        if (durations.length < RESERVOIR) durations.push(event.durationMs);
        else durations[durationCursor] = event.durationMs;
        durationCursor = (durationCursor + 1) % RESERVOIR;
        durationCount++;
      }
    },

    recordError(event: ErrorEvent): void {
      requestsTotal++;
      bySourceKind[event.sourceKind] = (bySourceKind[event.sourceKind] ?? 0) + 1;
      errorsTotal[event.code] = (errorsTotal[event.code] ?? 0) + 1;
    },

    snapshot(): MetricsSnapshot {
      const sorted = [...durations].sort((a, b) => a - b);
      return {
        requestsTotal,
        cacheHitsTotal,
        cacheMissesTotal,
        coalescedTotal,
        errorsTotal: { ...errorsTotal },
        outputBytesTotal,
        byFormat: { ...byFormat },
        bySourceKind: { ...bySourceKind },
        transformDurationMs: {
          count: durationCount,
          p50: quantile(sorted, 0.5),
          p95: quantile(sorted, 0.95),
          p99: quantile(sorted, 0.99),
        },
      };
    },

    reset(): void {
      requestsTotal = 0;
      cacheHitsTotal = 0;
      cacheMissesTotal = 0;
      coalescedTotal = 0;
      outputBytesTotal = 0;
      durations.length = 0;
      durationCursor = 0;
      durationCount = 0;
      for (const key of Object.keys(errorsTotal)) delete errorsTotal[key];
      for (const key of Object.keys(byFormat)) delete byFormat[key];
      for (const key of Object.keys(bySourceKind)) delete bySourceKind[key];
    },
  };
}

/**
 * Reduce a source reference to something safe to log.
 *
 * Query strings can carry signed URLs, tokens and expiry parameters, none of
 * which belong in a log line that will be shipped to a third-party aggregator.
 * Remote sources keep host and path; local sources keep the path.
 */
export function redactSource(source: string): string {
  if (!/^https?:\/\//i.test(source)) return source.split("?")[0]!;
  try {
    const url = new URL(source);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "[unparseable]";
  }
}

export function classifySource(source: string | undefined): SourceKind {
  if (source === undefined) return "bytes";
  return /^https?:\/\//i.test(source) ? "remote" : "local";
}

export type Logger = (line: Record<string, unknown>) => void;

/** Structured JSON on one line, in the §35 shape. */
export const consoleLogger: Logger = (line) => {
  console.log(JSON.stringify(line));
};
