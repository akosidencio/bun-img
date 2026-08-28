/**
 * The shared operation grammar behind both URL protocols.
 *
 * One vocabulary, two spellings:
 *
 *   /_image/w_800,q_75,f_webp/hero.jpg     operation-path, comma form
 *   /_image/w_800/q_75/f_webp/hero.jpg     operation-path, segment form
 *   /_image?url=/hero.jpg&w=800&q=75&f=webp   query
 *
 * All three normalize to the same transform, and therefore the same cache key.
 */
import type { ImageFormat, ImageTransform } from "../types.ts";
import { ImageError } from "../errors.ts";

/** Canonical emission order. Parsing accepts any order. */
export const OP_ORDER = ["w", "h", "fit", "q", "f", "enlarge", "orient"] as const;
export type OpKey = (typeof OP_ORDER)[number];

const OP_KEYS: ReadonlySet<string> = new Set(OP_ORDER);

const FORMATS: ReadonlySet<string> = new Set(["auto", "jpeg", "png", "webp", "avif", "heic"]);

function badRequest(message: string): never {
  throw new ImageError("INVALID_REQUEST", 400, message);
}

function parseInteger(raw: string, key: string): number {
  // Reject "+8", " 8", "8.0", "0x8" and other things Number() would accept.
  if (!/^\d+$/.test(raw)) badRequest(`${key} must be a non-negative integer, got "${raw}"`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) badRequest(`${key} is out of range`);
  return value;
}

function parseBoolean(raw: string, key: string): boolean {
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  badRequest(`${key} must be 0 or 1, got "${raw}"`);
}

function parseFormat(raw: string): "auto" | ImageFormat {
  if (!FORMATS.has(raw)) badRequest(`unsupported format "${raw}"`);
  return raw as "auto" | ImageFormat;
}

/**
 * Apply one `key=value` pair to a transform under construction.
 *
 * `enlarge` and `orient` are the URL-facing spellings; they map onto
 * `withoutEnlargement` (inverted) and `autoOrient`. Inverting at the boundary
 * keeps URLs readable without a negated option name leaking into them.
 */
export function applyOp(transform: ImageTransform, key: string, value: string): void {
  switch (key) {
    case "w":
      transform.width = parseInteger(value, "w");
      return;
    case "h":
      transform.height = parseInteger(value, "h");
      return;
    case "q":
      transform.quality = parseInteger(value, "q");
      return;
    case "f":
      transform.format = parseFormat(value);
      return;
    case "fit":
      if (value !== "inside" && value !== "fill") {
        badRequest(`fit must be "inside" or "fill", got "${value}"`);
      }
      transform.fit = value;
      return;
    case "enlarge":
      transform.withoutEnlargement = !parseBoolean(value, "enlarge");
      return;
    case "orient":
      transform.autoOrient = parseBoolean(value, "orient");
      return;
    default:
      badRequest(`unknown operation "${key}"`);
  }
}

/** Serialize a transform into canonical `key_value` pairs, defaults omitted. */
export function opPairs(transform: ImageTransform): Array<[OpKey, string]> {
  const pairs: Array<[OpKey, string]> = [];
  for (const key of OP_ORDER) {
    switch (key) {
      case "w":
        if (transform.width !== undefined) pairs.push(["w", String(transform.width)]);
        break;
      case "h":
        if (transform.height !== undefined) pairs.push(["h", String(transform.height)]);
        break;
      case "fit":
        if (transform.fit !== undefined) pairs.push(["fit", transform.fit]);
        break;
      case "q":
        if (transform.quality !== undefined) pairs.push(["q", String(transform.quality)]);
        break;
      case "f":
        if (transform.format !== undefined) pairs.push(["f", transform.format]);
        break;
      case "enlarge":
        if (transform.withoutEnlargement !== undefined) {
          pairs.push(["enlarge", transform.withoutEnlargement ? "0" : "1"]);
        }
        break;
      case "orient":
        if (transform.autoOrient !== undefined) {
          pairs.push(["orient", transform.autoOrient ? "1" : "0"]);
        }
        break;
    }
  }
  return pairs;
}

/**
 * Does this path segment consist entirely of known operations?
 *
 * Used to decide where the operation prefix stops and the source path begins.
 * Requiring *known* keys rather than merely `key_value` shape means a directory
 * called `my_photos` or a file called `w_800.jpg` is treated as source rather
 * than as a malformed operation — the failure mode becomes a 404 for a missing
 * file instead of a confusing 400.
 */
export function isOpsSegment(segment: string): boolean {
  if (segment.length === 0) return false;
  const groups = segment.split(",");
  return groups.every((group) => {
    const idx = group.indexOf("_");
    if (idx <= 0) return false;
    // A known key with an empty value (`w_`) is still an operation — a
    // malformed one. Recognizing it here means it reaches the parser and gets a
    // 400, rather than being mistaken for a directory called "w_".
    return OP_KEYS.has(group.slice(0, idx));
  });
}

/** Parse one segment of comma-joined operations into a transform. */
export function parseOpsSegment(segment: string, into: ImageTransform, seen: Set<string>): void {
  for (const group of segment.split(",")) {
    const idx = group.indexOf("_");
    if (idx <= 0 || idx === group.length - 1) badRequest(`malformed operation "${group}"`);
    const key = group.slice(0, idx);
    const value = group.slice(idx + 1);
    // Duplicates are rejected rather than last-wins: two spellings of one
    // request would otherwise reach the same bytes by different URLs.
    if (seen.has(key)) badRequest(`operation "${key}" specified more than once`);
    seen.add(key);
    applyOp(into, key, value);
  }
}
