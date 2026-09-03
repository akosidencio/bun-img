/**
 * Remote sources.
 *
 * The validation chain, in order, for the initial URL and again for **every**
 * redirect hop:
 *
 *   1. shape — protocol, credentials, port
 *   2. allowlist — the operator's patterns
 *   3. pre-DNS — reject IP literals and internal-looking hostnames
 *   4. DNS — resolve, and classify *every* returned address
 *   5. fetch with `redirect: "manual"`
 *   6. streaming byte cap while reading the body
 *
 * A redirect is a fresh untrusted URL and gets the whole chain again. Skipping
 * step 2 on redirects is the classic bypass: an allowlisted host 302s to
 * `http://169.254.169.254/`.
 *
 * `identify` runs the same chain with a `HEAD`, so a warm cache is served
 * without downloading the source at all. It walks redirects through the very
 * same loop — a cheaper path that skipped a hop check would be a hole in
 * exactly the defence above.
 *
 * Residual risk, stated plainly: between step 4 and step 5 the name could be
 * re-resolved to a different address (DNS rebinding). Bun's `fetch` cannot be
 * pinned to a validated IP, and connecting by IP would break TLS verification.
 * Bun's DNS cache makes the window small but not zero. The mitigation that does
 * hold is that a rebound address still has to serve bytes that decode as an
 * image, and the response never reaches the client as anything else.
 */
import { ImageError } from "../errors.ts";
import { classifyIp, hostnameVerdict, isIpLiteral } from "./ip.ts";
import { matchesAnyPattern, type RemotePattern } from "./patterns.ts";
import type { SourceIdentity } from "../types.ts";
import type { ResolveContext, ResolvedSource, SourceResolver } from "./types.ts";

/** Injectable so tests can drive rebinding and hostile-origin scenarios. */
export type LookupFn = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

export interface RemoteSourceOptions {
  /** Empty (the default) disables remote sources entirely. */
  patterns?: readonly RemotePattern[];
  maxRedirects?: number;
  /** Whole-request budget, headers and body together. */
  timeout?: number;
  maxSourceBytes?: number;
  /** Sent on every upstream request. */
  userAgent?: string;
  /**
   * Answer `identify()` with a `HEAD`, so a warm cache can be served without
   * downloading the source. Default `true`.
   *
   * The trade is one extra round trip on a cache *miss* against a whole body
   * saved on every cache *hit*. Turn it off for an origin that mishandles
   * `HEAD`, or one whose images are small enough that the round trip costs more
   * than the bytes. The engine only asks when a result cache is configured.
   */
  identify?: boolean;
  lookup?: LookupFn;
  fetch?: FetchFn;
}

/**
 * Query parameters that authenticate a URL rather than name the object.
 *
 * A presigned URL's signature rotates on every issue, so leaving it in the
 * identity gives the same object a new cache key every few minutes — the cache
 * never hits and every request re-downloads and re-encodes.
 *
 * Stripping is deliberately narrow. Dropping a parameter that *does* select
 * content would collapse two different images onto one cache entry and serve
 * the wrong bytes, which is far worse than a cache miss. So each scheme is
 * gated on a marker parameter that no ordinary URL carries, and only that
 * scheme's own parameters are removed; everything else — `?v=2`, `?page=3` —
 * stays part of the identity.
 */
const SIGNING_SCHEMES: ReadonlyArray<{
  /** All must be present, lowercased, before anything is stripped. */
  markers: readonly string[];
  /** Exact names to drop, lowercased. */
  params?: readonly string[];
  /** Name prefixes to drop, lowercased. */
  prefixes?: readonly string[];
}> = [
  // AWS SigV4 presigned — S3, and everything that speaks it: R2, DigitalOcean
  // Spaces, MinIO, Wasabi, Backblaze B2's S3 API.
  { markers: ["x-amz-signature"], prefixes: ["x-amz-"] },
  // Google Cloud Storage V4 signed URLs.
  { markers: ["x-goog-signature"], prefixes: ["x-goog-"] },
  // CloudFront signed URLs. `Signature` and `Expires` are generic enough to
  // appear on an ordinary URL, so both markers are required together.
  {
    markers: ["key-pair-id", "signature"],
    params: ["expires", "signature", "key-pair-id", "policy"],
  },
  // Azure Blob SAS. `sv` (service version) and `sig` are always both present.
  {
    markers: ["sig", "sv"],
    params: [
      "sv", "st", "se", "sr", "sp", "spr", "sig", "sip", "si",
      "skoid", "sktid", "skt", "ske", "sks", "skv", "rscd", "rsct",
    ],
  },
];

/**
 * The stable identity of a remote object: its URL, minus anything that changes
 * without the bytes changing.
 *
 * Also sorts the surviving parameters and drops the fragment, so two spellings
 * of one request do not become two cache entries. The fragment never reaches
 * the origin in the first place.
 */
export function canonicalSourceUrl(input: URL): string {
  const url = new URL(input.toString());
  url.hash = "";

  const present = new Set([...url.searchParams.keys()].map((k) => k.toLowerCase()));

  for (const scheme of SIGNING_SCHEMES) {
    if (!scheme.markers.every((m) => present.has(m))) continue;
    for (const key of [...url.searchParams.keys()]) {
      const lower = key.toLowerCase();
      const drop =
        (scheme.params?.includes(lower) ?? false) ||
        (scheme.prefixes?.some((p) => lower.startsWith(p)) ?? false);
      if (drop) url.searchParams.delete(key);
    }
  }

  url.searchParams.sort();
  return url.toString();
}

/** Content types worth attempting to decode. Advisory: the decoder decides. */
const IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
  "image/gif",
  "image/tiff",
  "image/bmp",
  "application/octet-stream",
]);

function refuse(message: string): never {
  // One message for every allowlist and address failure, so the endpoint cannot
  // be used to probe which internal hosts exist.
  void message;
  throw new ImageError("SOURCE_NOT_ALLOWED", 403, "source not allowed");
}

/**
 * `Bun.dns.lookup` returns *every* address for a hostname by default, which is
 * what the validation rule needs — a name with one public and one private A
 * record must be refused, since which address gets connected to is not ours to
 * choose. Bun also caches lookups, which narrows (without closing) the rebinding
 * window described above.
 */
const defaultLookup: LookupFn = async (hostname) => {
  const result = await Bun.dns.lookup(hostname);
  return result.map((r) => ({ address: r.address, family: r.family }));
};

export function createRemoteResolver(options: RemoteSourceOptions = {}): SourceResolver {
  const patterns = options.patterns ?? [];
  const maxRedirects = options.maxRedirects ?? 3;
  const timeout = options.timeout ?? 10_000;
  const maxBytes = options.maxSourceBytes ?? 20 * 1024 * 1024;
  const userAgent = options.userAgent ?? "bun-img";
  const canIdentify = options.identify ?? true;
  const lookup = options.lookup ?? defaultLookup;
  const doFetch = options.fetch ?? ((url, init) => fetch(url, init));

  /** Steps 1–4, applied to a URL that is about to be requested. */
  async function validate(url: URL): Promise<void> {
    if (url.protocol !== "https:" && url.protocol !== "http:") refuse("protocol");
    // Credentials in the URL are a redirect-laundering trick and are never
    // needed for a public image.
    if (url.username !== "" || url.password !== "") refuse("credentials in URL");
    if (patterns.length === 0) refuse("remote sources disabled");
    if (!matchesAnyPattern(patterns, url)) refuse("not in allowlist");

    const pre = hostnameVerdict(url.hostname);
    if (!pre.allowed) refuse(pre.reason ?? "hostname");

    // An IP literal was already fully judged by hostnameVerdict; no DNS needed.
    if (isIpLiteral(url.hostname)) return;

    let addresses: Array<{ address: string }>;
    try {
      addresses = await lookup(url.hostname);
    } catch {
      throw new ImageError("FETCH_FAILED", 502, "could not resolve source host");
    }
    if (addresses.length === 0) refuse("no addresses");

    // Every address, not just the first: a hostname with one public and one
    // private A record must be refused, because which one gets connected to is
    // not ours to choose.
    for (const { address } of addresses) {
      const verdict = classifyIp(address);
      if (!verdict.allowed) refuse(verdict.reason ?? "address");
    }
  }

  /**
   * One deadline for the entire operation — headers, redirects and body.
   *
   * A per-request timeout would let a slowloris body run forever after fast
   * headers, and a redirect chain multiply the budget by `maxRedirects`.
   */
  function deadlineFor(context: ResolveContext): AbortSignal {
    const deadline = AbortSignal.timeout(timeout);
    return context.signal ? AbortSignal.any([deadline, context.signal]) : deadline;
  }

  /**
   * Walk the redirect chain, revalidating every hop, and return the first
   * non-redirect response.
   *
   * `resolve` and `identify` share this so their validation cannot drift: a
   * `HEAD` that skipped a hop check would be a hole in exactly the defence the
   * loop exists for.
   */
  async function walk(
    start: URL,
    method: "GET" | "HEAD",
    signal: AbortSignal,
  ): Promise<Response> {
    let url = start;
    const seen = new Set<string>();

    for (let hop = 0; hop <= maxRedirects; hop++) {
      await validate(url);

      // Redirect loops are bounded by maxRedirects anyway; this reports them
      // as what they are instead of as a redirect-limit overflow.
      const visited = url.toString();
      if (seen.has(visited)) {
        throw new ImageError("FETCH_FAILED", 502, "redirect loop");
      }
      seen.add(visited);

      let response: Response;
      try {
        response = await doFetch(visited, {
          method,
          redirect: "manual",
          signal,
          headers: { accept: "image/*", "user-agent": userAgent },
        });
      } catch (err) {
        if (signal.aborted) {
          throw new ImageError("FETCH_TIMEOUT", 504, "timed out fetching source");
        }
        throw new ImageError("FETCH_FAILED", 502, "could not fetch source", { cause: err });
      }

      if (response.status < 300 || response.status > 399) return response;

      const location = response.headers.get("location");
      if (location === null) {
        throw new ImageError("FETCH_FAILED", 502, "redirect without a location");
      }
      // Drain so the connection can be reused rather than left dangling.
      await response.body?.cancel().catch(() => {});

      try {
        url = new URL(location, visited);
      } catch {
        throw new ImageError("FETCH_FAILED", 502, "malformed redirect location");
      }

      if (hop === maxRedirects) {
        throw new ImageError("FETCH_FAILED", 502, "too many redirects");
      }
    }

    throw new ImageError("FETCH_FAILED", 502, "too many redirects");
  }

  return {
    name: "remote",

    supports(source: string): boolean {
      return /^https?:\/\//i.test(source);
    },

    /**
     * Establish identity with a `HEAD`, so the engine can answer from cache
     * without downloading anything.
     *
     * Returns `null` — never throws — for every failure, including a refusal:
     * `resolve` is the single place that decides what is allowed, and reporting
     * it twice would mean two things to keep in agreement. A `null` costs one
     * fall-through to the slow path, which produces the real error.
     *
     * A source with no validator also returns `null`. An identity without a
     * version cannot detect that the origin changed, and on this path that
     * would not merely risk a stale answer — it would pin one forever, since
     * the fast path never opens the source to notice.
     */
    async identify(source: string, context: ResolveContext): Promise<SourceIdentity | null> {
      if (!canIdentify) return null;

      let requested: URL;
      try {
        requested = new URL(source);
      } catch {
        return null;
      }

      try {
        const response = await walk(requested, "HEAD", deadlineFor(context));
        await response.body?.cancel().catch(() => {});
        if (!response.ok) return null;

        // An origin that refuses HEAD, or answers it without a validator, opts
        // itself out of the fast path rather than breaking.
        const version =
          response.headers.get("etag") ?? response.headers.get("last-modified");
        if (version === null) return null;

        return { id: identityFor(requested), version };
      } catch {
        return null;
      }
    },

    async resolve(source: string, context: ResolveContext): Promise<ResolvedSource> {
      let requested: URL;
      try {
        requested = new URL(source);
      } catch {
        throw new ImageError("INVALID_REQUEST", 400, "malformed source URL");
      }

      const signal = deadlineFor(context);
      const response = await walk(requested, "GET", signal);

      if (response.status === 404 || response.status === 410) {
        await response.body?.cancel().catch(() => {});
        throw new ImageError("SOURCE_NOT_FOUND", 404, "source not found");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new ImageError("FETCH_FAILED", 502, `upstream returned ${response.status}`);
      }

      const contentType = (response.headers.get("content-type") ?? "")
        .split(";")[0]!
        .trim()
        .toLowerCase();
      if (contentType !== "" && !IMAGE_CONTENT_TYPES.has(contentType)) {
        await response.body?.cancel().catch(() => {});
        throw new ImageError("UNSUPPORTED_FORMAT", 415, "source is not an image");
      }

      // Content-Length is a hint from an untrusted party. Checking it early
      // avoids a pointless read, but the streaming cap below is the real limit.
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body?.cancel().catch(() => {});
        throw new ImageError("SOURCE_TOO_LARGE", 413, "source exceeds the size limit");
      }

      const data = await readCapped(response, maxBytes, signal);

      // ETag first, then Last-Modified. Without either the engine cannot detect
      // source changes, so the identity carries no version and the HTTP layer
      // must not mark the response immutable.
      const etag = response.headers.get("etag");
      const lastModified = response.headers.get("last-modified");
      const version = etag ?? lastModified ?? undefined;

      const id = identityFor(requested);
      return {
        data,
        kind: "remote",
        ...(contentType === "" ? {} : { contentType }),
        identity: version === undefined ? { id } : { id, version },
      };
    },
  };
}

/**
 * The identity of a requested source.
 *
 * Keyed on the URL as *requested*, not the one a redirect landed on. The two
 * have to agree, because `identify` cannot know the redirect target without
 * following it, and an identity that disagreed with `resolve`'s would file
 * every cache entry under a key the fast path then failed to find.
 */
function identityFor(requested: URL): string {
  return `remote:${canonicalSourceUrl(requested)}`;
}

/**
 * Read a response body, aborting the moment it exceeds the cap.
 *
 * `Bun.Image` takes only fully-buffered input, so the bytes have to be
 * accumulated — which is exactly why the cap has to be enforced *during* the
 * read. A hostile origin that omits Content-Length and streams indefinitely is
 * stopped after `max` bytes rather than after the whole body.
 */
export async function readCapped(
  response: Response,
  max: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new ImageError("FETCH_FAILED", 502, "empty response body");

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      if (signal?.aborted) {
        throw new ImageError("FETCH_TIMEOUT", 504, "timed out reading source");
      }
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new ImageError("SOURCE_TOO_LARGE", 413, "source exceeds the size limit");
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (err instanceof ImageError) throw err;
    if (signal?.aborted) {
      throw new ImageError("FETCH_TIMEOUT", 504, "timed out reading source");
    }
    throw new ImageError("FETCH_FAILED", 502, "could not read source body", { cause: err });
  }

  if (total === 0) throw new ImageError("FETCH_FAILED", 502, "empty response body");

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
