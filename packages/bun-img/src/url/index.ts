/**
 * URL building and parsing for both protocols.
 *
 * Nothing here touches `Bun.Image`, so this module is safe to run in a browser
 * bundle — which is what lets framework adapters generate `srcset` on the
 * client while every pixel operation stays server-side.
 */
import type { ImageTransform } from "../types.ts";
import { ImageError } from "../errors.ts";
import { applyOp, isOpsSegment, opPairs, parseOpsSegment } from "./ops.ts";

export { OP_ORDER } from "./ops.ts";
export type { OpKey } from "./ops.ts";

function badRequest(message: string): never {
  throw new ImageError("INVALID_REQUEST", 400, message);
}

export interface ParsedImageRequest {
  /** Source reference, exactly as written. Resolution is Phase 2's job. */
  readonly source: string;
  readonly transform: ImageTransform;
  readonly protocol: "query" | "path";
}

export interface UrlOptions {
  /** Endpoint prefix. Defaults to `/_image`. */
  basePath?: string;
}

function normalizeBasePath(basePath: string): string {
  if (!basePath.startsWith("/")) badRequest("basePath must start with /");
  return basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
}

/* ────────────────────────────── building ────────────────────────────────── */

/**
 * Build an operation-path URL: `/_image/w_800,q_75/hero.jpg`.
 *
 * The comma form is canonical. It keeps the whole transform in a single path
 * segment, which removes any ambiguity about where operations end and the
 * source path begins.
 */
export function imageUrl(
  source: string,
  transform: ImageTransform = {},
  options: UrlOptions = {},
): string {
  const base = normalizeBasePath(options.basePath ?? "/_image");
  const pairs = opPairs(transform);
  const cleanSource = source.startsWith("/") ? source.slice(1) : source;

  if (cleanSource.length === 0) badRequest("source must not be empty");

  const encodedSource = cleanSource.split("/").map(encodeURIComponent).join("/");
  if (pairs.length === 0) return `${base}/${encodedSource}`;

  const ops = pairs.map(([k, v]) => `${k}_${v}`).join(",");
  return `${base}/${ops}/${encodedSource}`;
}

/**
 * Build a query URL: `/_image?url=/hero.jpg&w=800&q=75`.
 *
 * Needed for the Next.js adapter, whose custom loader receives only
 * `{ src, width, quality }` and cannot see the `Accept` header — so `f=auto`
 * goes on the URL and negotiation happens server-side at the endpoint.
 */
export function imageQueryUrl(
  source: string,
  transform: ImageTransform = {},
  options: UrlOptions = {},
): string {
  const base = normalizeBasePath(options.basePath ?? "/_image");
  if (source.length === 0) badRequest("source must not be empty");

  const params = new URLSearchParams();
  params.set("url", source);
  for (const [key, value] of opPairs(transform)) params.set(key, value);
  return `${base}?${params.toString()}`;
}

/* ────────────────────────────── parsing ─────────────────────────────────── */

function parseQueryProtocol(url: URL): ParsedImageRequest {
  const source = url.searchParams.get("url");
  if (source === null || source.length === 0) badRequest("missing url parameter");

  const transform: ImageTransform = {};
  const seen = new Set<string>();

  for (const key of new Set(url.searchParams.keys())) {
    if (key === "url") continue;
    const values = url.searchParams.getAll(key);
    if (values.length > 1) badRequest(`parameter "${key}" specified more than once`);
    if (seen.has(key)) badRequest(`parameter "${key}" specified more than once`);
    seen.add(key);
    // Unknown parameters are rejected rather than ignored. Silently dropping a
    // misspelled `width=` would serve a correct-looking image at the wrong size.
    applyOp(transform, key, values[0]!);
  }

  return { source, transform, protocol: "query" };
}

function parsePathProtocol(url: URL, base: string): ParsedImageRequest {
  const rest = url.pathname.slice(base.length + 1);
  const segments = rest.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) badRequest("missing source path");

  const transform: ImageTransform = {};
  const seen = new Set<string>();

  // Consume leading operation segments, but never the last remaining segment —
  // that is the source, even when it happens to look like an operation
  // (`/_image/w_800.jpg` is a file called `w_800.jpg`, not a width).
  let i = 0;
  while (i < segments.length - 1 && isOpsSegment(segments[i]!)) {
    parseOpsSegment(segments[i]!, transform, seen);
    i++;
  }

  const source = segments.slice(i).map(decodeURIComponent).join("/");
  if (source.length === 0) badRequest("missing source path");

  return { source, transform, protocol: "path" };
}

/**
 * Parse a request URL under `basePath` into a source and an unresolved
 * transform. Normalization and negotiation happen afterwards, against config.
 */
export function parseImageRequest(
  input: URL | string,
  options: UrlOptions = {},
): ParsedImageRequest {
  const base = normalizeBasePath(options.basePath ?? "/_image");
  const url = typeof input === "string" ? new URL(input, "http://localhost") : input;
  const pathname = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;

  if (pathname === base) return parseQueryProtocol(url);
  if (url.pathname.startsWith(`${base}/`)) return parsePathProtocol(url, base);

  badRequest(`request path does not start with ${base}`);
}

/* ────────────────────────────── srcset ──────────────────────────────────── */

export interface SrcsetOptions extends UrlOptions {
  widths: readonly number[];
  /** The `sizes` attribute to emit. Defaults to `100vw`. */
  sizes?: string;
  /** Applied to every generated width. `width` is overridden per entry. */
  transform?: Omit<ImageTransform, "width">;
}

export interface Srcset {
  readonly src: string;
  readonly srcset: string;
  readonly sizes: string;
  readonly width: number;
}

/**
 * Build `src`, `srcset` and `sizes` for a responsive image.
 *
 * `src` points at the largest width, so a browser that ignores `srcset` still
 * gets a usable image rather than the smallest one.
 */
export function srcset(source: string, options: SrcsetOptions): Srcset {
  const widths = [...new Set(options.widths)].sort((a, b) => a - b);
  if (widths.length === 0) badRequest("srcset needs at least one width");
  if (widths.some((w) => !Number.isInteger(w) || w < 1)) {
    badRequest("srcset widths must be positive integers");
  }

  const base = options.transform ?? {};
  const entries = widths.map((width) => {
    const url = imageUrl(source, { ...base, width }, options);
    return `${url} ${width}w`;
  });

  const largest = widths[widths.length - 1]!;
  return {
    src: imageUrl(source, { ...base, width: largest }, options),
    srcset: entries.join(", "),
    sizes: options.sizes ?? "100vw",
    width: largest,
  };
}
