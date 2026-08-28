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
  lookup?: LookupFn;
  fetch?: FetchFn;
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

  return {
    name: "remote",

    supports(source: string): boolean {
      return /^https?:\/\//i.test(source);
    },

    async resolve(source: string, context: ResolveContext): Promise<ResolvedSource> {
      let url: URL;
      try {
        url = new URL(source);
      } catch {
        throw new ImageError("INVALID_REQUEST", 400, "malformed source URL");
      }

      // One deadline for the entire operation — headers, redirects and body.
      // A per-request timeout would let a slowloris body run forever after fast
      // headers, and a redirect chain multiply the budget by maxRedirects.
      const deadline = AbortSignal.timeout(timeout);
      const signal = context.signal
        ? AbortSignal.any([deadline, context.signal])
        : deadline;

      const seen = new Set<string>();
      let response: Response | undefined;

      for (let hop = 0; hop <= maxRedirects; hop++) {
        await validate(url);

        // Redirect loops are bounded by maxRedirects anyway; this reports them
        // as what they are instead of as a redirect-limit overflow.
        const visited = url.toString();
        if (seen.has(visited)) {
          throw new ImageError("FETCH_FAILED", 502, "redirect loop");
        }
        seen.add(visited);

        try {
          response = await doFetch(visited, {
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

        if (response.status < 300 || response.status > 399) break;

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

      if (!response) throw new ImageError("FETCH_FAILED", 502, "no response");

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

      const id = `remote:${url.toString()}`;
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
