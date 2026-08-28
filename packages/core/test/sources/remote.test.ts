/**
 * The SSRF matrix, plus a real hostile origin.
 *
 * IP validation is tested directly in `ip.test.ts`. Here the DNS lookup is
 * stubbed to report a public address so that a genuine local server can stand in
 * for a hostile origin — redirect loops, lying Content-Types, unbounded bodies
 * and slowloris all need real HTTP to be worth testing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRemoteResolver, readCapped, type LookupFn } from "../../src/sources/remote.ts";
import type { RemotePattern } from "../../src/sources/patterns.ts";
import { resolveConfig } from "../../src/config.ts";
import { expectCode, makeImage } from "../helpers.ts";

const cfg = resolveConfig();
const ctx = { config: cfg };

/** Pretend every hostname is a public address, so IP checks do not fire. */
const publicLookup: LookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

/**
 * The resolver sees a public-looking hostname; the bytes come from a real local
 * server. An IP literal cannot be used directly here — `127.0.0.1` is rejected
 * by the pre-DNS check before any stub gets a say, which is exactly right.
 */
const ORIGIN = "http://images.test";

let server: ReturnType<typeof Bun.serve>;
let origin: string;
let loopback: string;
let pngBytes: Uint8Array;

/** Rewrites the validated public URL onto the local server. */
const routedFetch = (url: string, init: RequestInit) =>
  fetch(url.replace(ORIGIN, loopback), init);

beforeAll(async () => {
  pngBytes = await makeImage(64, 64, "png");

  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/image.png") {
        return new Response(pngBytes, {
          headers: { "content-type": "image/png", etag: '"abc123"' },
        });
      }

      if (path === "/no-validators") {
        return new Response(pngBytes, { headers: { "content-type": "image/png" } });
      }

      if (path === "/last-modified") {
        return new Response(pngBytes, {
          headers: {
            "content-type": "image/png",
            "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT",
          },
        });
      }

      // HTML wearing an image Content-Type: passes the header check, must fail
      // at decode. The header is not the defence; the decoder is.
      if (path === "/html-as-jpeg") {
        return new Response("<html><body>gotcha</body></html>", {
          headers: { "content-type": "image/jpeg" },
        });
      }

      if (path === "/actually-html") {
        return new Response("<html></html>", { headers: { "content-type": "text/html" } });
      }

      if (path === "/no-content-type") {
        return new Response(pngBytes);
      }

      // Endless body with no Content-Length — the cap has to bite mid-stream.
      if (path === "/endless") {
        const stream = new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(64 * 1024));
          },
        });
        return new Response(stream, { headers: { "content-type": "image/png" } });
      }

      // Headers arrive fast, body trickles and never ends.
      if (path === "/slowloris") {
        const stream = new ReadableStream({
          async pull(controller) {
            controller.enqueue(new Uint8Array(1));
            await Bun.sleep(50_000);
          },
        });
        return new Response(stream, { headers: { "content-type": "image/png" } });
      }

      if (path === "/lies-about-length") {
        return new Response(pngBytes, {
          headers: { "content-type": "image/png", "content-length": "999999999" },
        });
      }

      if (path === "/redirect-loop-a") {
        return new Response(null, { status: 302, headers: { location: `${origin}/redirect-loop-b` } });
      }
      if (path === "/redirect-loop-b") {
        return new Response(null, { status: 302, headers: { location: `${origin}/redirect-loop-a` } });
      }

      if (path.startsWith("/redirect-chain/")) {
        const n = Number(path.slice("/redirect-chain/".length));
        if (n <= 0) return new Response(pngBytes, { headers: { "content-type": "image/png" } });
        return new Response(null, {
          status: 302,
          headers: { location: `${origin}/redirect-chain/${n - 1}` },
        });
      }

      // The classic bypass: an allowlisted host redirecting into the metadata service.
      if (path === "/redirect-to-metadata") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      }

      if (path === "/redirect-offsite") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://not-allowed.example.com/a.png" },
        });
      }

      if (path === "/redirect-no-location") {
        return new Response(null, { status: 302 });
      }

      if (path === "/gone") return new Response("gone", { status: 410 });
      if (path === "/boom") return new Response("boom", { status: 500 });

      return new Response("not found", { status: 404 });
    },
  });

  loopback = `http://127.0.0.1:${server.port}`;
  origin = ORIGIN;
});

afterAll(() => {
  server.stop(true);
});

/** A resolver that trusts our loopback origin, with DNS stubbed public. */
function resolver(over: Partial<Parameters<typeof createRemoteResolver>[0]> = {}) {
  const patterns: RemotePattern[] = [{ protocol: "http", hostname: "images.test" }];
  return createRemoteResolver({ patterns, lookup: publicLookup, fetch: routedFetch, ...over });
}

describe("supports", () => {
  test("claims http and https only", () => {
    const r = resolver();
    expect(r.supports("https://example.com/a.png")).toBe(true);
    expect(r.supports("http://example.com/a.png")).toBe(true);
    expect(r.supports("HTTPS://example.com/a.png")).toBe(true);
    expect(r.supports("/a.png")).toBe(false);
    expect(r.supports("file:///etc/passwd")).toBe(false);
    expect(r.supports("data:image/png;base64,AA")).toBe(false);
  });
});

describe("allowlist", () => {
  test("remote is disabled when no patterns are configured", async () => {
    const r = createRemoteResolver({ lookup: publicLookup, fetch: routedFetch });
    await expectCode(() => r.resolve(`${origin}/image.png`, ctx), "SOURCE_NOT_ALLOWED");
  });

  test("refuses a host that is not in the allowlist", async () => {
    await expectCode(
      () => resolver().resolve("https://evil.example.com/a.png", ctx),
      "SOURCE_NOT_ALLOWED",
    );
  });

  test("refuses credentials embedded in the URL", async () => {
    await expectCode(
      () => resolver().resolve("http://user:pass@images.test/image.png", ctx),
      "SOURCE_NOT_ALLOWED",
    );
  });

  test("refuses non-http protocols", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/a.png", "gopher://a/b"]) {
      await expectCode(() => resolver().resolve(url, ctx), "SOURCE_NOT_ALLOWED");
    }
  });

  test("refuses a malformed URL", async () => {
    await expectCode(() => resolver().resolve("http://[bad", ctx), "INVALID_REQUEST");
  });
});

describe("address validation", () => {
  test("refuses when DNS returns a private address", async () => {
    const rebinding: LookupFn = async () => [{ address: "127.0.0.1", family: 4 }];
    await expectCode(
      () => resolver({ lookup: rebinding }).resolve(`${origin}/image.png`, ctx),
      "SOURCE_NOT_ALLOWED",
    );
  });

  test("refuses when DNS returns the cloud metadata address", async () => {
    const metadata: LookupFn = async () => [{ address: "169.254.169.254", family: 4 }];
    await expectCode(
      () => resolver({ lookup: metadata }).resolve(`${origin}/image.png`, ctx),
      "SOURCE_NOT_ALLOWED",
    );
  });

  test("refuses when ANY returned address is private, not just the first", async () => {
    // Which address gets connected to is not ours to choose.
    const mixed: LookupFn = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ];
    await expectCode(
      () => resolver({ lookup: mixed }).resolve(`${origin}/image.png`, ctx),
      "SOURCE_NOT_ALLOWED",
    );
  });

  test("refuses an IPv4-mapped IPv6 private address", async () => {
    const mapped: LookupFn = async () => [{ address: "::ffff:169.254.169.254", family: 6 }];
    await expectCode(
      () => resolver({ lookup: mapped }).resolve(`${origin}/image.png`, ctx),
      "SOURCE_NOT_ALLOWED",
    );
  });

  test("refuses an empty DNS answer", async () => {
    const empty: LookupFn = async () => [];
    await expectCode(
      () => resolver({ lookup: empty }).resolve(`${origin}/image.png`, ctx),
      "SOURCE_NOT_ALLOWED",
    );
  });

  test("reports a DNS failure as a fetch failure, not an allowlist refusal", async () => {
    const broken: LookupFn = async () => {
      throw new Error("SERVFAIL");
    };
    await expectCode(
      () => resolver({ lookup: broken }).resolve(`${origin}/image.png`, ctx),
      "FETCH_FAILED",
    );
  });

  test("an IP-literal host is judged without any DNS at all", async () => {
    let called = false;
    const spy: LookupFn = async () => {
      called = true;
      return [{ address: "93.184.216.34", family: 4 }];
    };
    const r = createRemoteResolver({
      patterns: [{ protocol: "http", hostname: "169.254.169.254" }],
      lookup: spy,
      fetch: routedFetch,
    });
    await expectCode(() => r.resolve("http://169.254.169.254/a.png", ctx), "SOURCE_NOT_ALLOWED");
    expect(called).toBe(false);
  });
});

describe("fetching", () => {
  test("fetches an allowed image", async () => {
    const out = await resolver().resolve(`${origin}/image.png`, ctx);
    expect(out.kind).toBe("remote");
    expect(out.contentType).toBe("image/png");
    expect((out.data as Uint8Array).byteLength).toBe(pngBytes.byteLength);
  });

  test("uses the ETag as the cache version", async () => {
    const out = await resolver().resolve(`${origin}/image.png`, ctx);
    expect(out.identity.version).toBe('"abc123"');
  });

  test("falls back to Last-Modified", async () => {
    const out = await resolver().resolve(`${origin}/last-modified`, ctx);
    expect(out.identity.version).toBe("Wed, 21 Oct 2026 07:28:00 GMT");
  });

  test("carries no version when the origin supplies no validator", async () => {
    // The signal to the HTTP layer that it must not claim `immutable`.
    const out = await resolver().resolve(`${origin}/no-validators`, ctx);
    expect(out.identity.version).toBeUndefined();
  });

  test("accepts a missing Content-Type and lets the decoder decide", async () => {
    const out = await resolver().resolve(`${origin}/no-content-type`, ctx);
    expect((out.data as Uint8Array).byteLength).toBeGreaterThan(0);
  });

  test("maps 404 and 410 to SOURCE_NOT_FOUND", async () => {
    await expectCode(() => resolver().resolve(`${origin}/missing`, ctx), "SOURCE_NOT_FOUND");
    await expectCode(() => resolver().resolve(`${origin}/gone`, ctx), "SOURCE_NOT_FOUND");
  });

  test("maps a 5xx to FETCH_FAILED", async () => {
    await expectCode(() => resolver().resolve(`${origin}/boom`, ctx), "FETCH_FAILED");
  });
});

describe("content type", () => {
  test("refuses an obviously non-image Content-Type early", async () => {
    await expectCode(() => resolver().resolve(`${origin}/actually-html`, ctx), "UNSUPPORTED_FORMAT");
  });

  test("HTML claiming image/jpeg gets through the header check — by design", async () => {
    // Content-Type is a hint from an untrusted party, so it can only reject the
    // obvious. The bytes still have to decode, which happens in the engine.
    const out = await resolver().resolve(`${origin}/html-as-jpeg`, ctx);
    expect(new TextDecoder().decode(out.data as Uint8Array)).toContain("gotcha");
  });
});

describe("size limits", () => {
  test("aborts an endless body once the cap is exceeded", async () => {
    await expectCode(
      () => resolver({ maxSourceBytes: 256 * 1024 }).resolve(`${origin}/endless`, ctx),
      "SOURCE_TOO_LARGE",
    );
  });

  test("rejects early when the declared Content-Length is over the cap", async () => {
    await expectCode(
      () => resolver({ maxSourceBytes: 32 }).resolve(`${origin}/lies-about-length`, ctx),
      "SOURCE_TOO_LARGE",
    );
  });

  test("the streaming cap wins when Content-Length lies the other way", async () => {
    // A header claiming 1 byte in front of a 5000-byte body. Trusting the
    // header would let the whole thing through; the cap counts real bytes.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(5000));
        controller.close();
      },
    });
    const lying = new Response(stream, { headers: { "content-length": "1" } });
    await expectCode(() => readCapped(lying, 1000), "SOURCE_TOO_LARGE");
  });

  test("allows a body within the cap", async () => {
    const out = await resolver({ maxSourceBytes: 1024 * 1024 }).resolve(`${origin}/image.png`, ctx);
    expect((out.data as Uint8Array).byteLength).toBe(pngBytes.byteLength);
  });
});

describe("timeouts", () => {
  test("a slowloris body hits the deadline", async () => {
    await expectCode(
      () => resolver({ timeout: 300 }).resolve(`${origin}/slowloris`, ctx),
      "FETCH_TIMEOUT",
    );
  }, 10_000);

  test("an external abort signal cancels resolution", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    await expectCode(
      () =>
        resolver({ timeout: 30_000 }).resolve(`${origin}/slowloris`, {
          config: cfg,
          signal: controller.signal,
        }),
      "FETCH_TIMEOUT",
    );
  }, 10_000);
});

describe("redirects", () => {
  test("follows a short chain", async () => {
    const out = await resolver({ maxRedirects: 3 }).resolve(`${origin}/redirect-chain/2`, ctx);
    expect((out.data as Uint8Array).byteLength).toBe(pngBytes.byteLength);
  });

  test("refuses a chain longer than maxRedirects", async () => {
    await expectCode(
      () => resolver({ maxRedirects: 2 }).resolve(`${origin}/redirect-chain/5`, ctx),
      "FETCH_FAILED",
    );
  });

  test("detects a redirect loop", async () => {
    await expectCode(
      () => resolver({ maxRedirects: 5 }).resolve(`${origin}/redirect-loop-a`, ctx),
      "FETCH_FAILED",
    );
  });

  test("re-validates the allowlist on every hop", async () => {
    // An allowlisted host redirecting off-allowlist must not be followed.
    await expectCode(
      () => resolver().resolve(`${origin}/redirect-offsite`, ctx),
      "SOURCE_NOT_ALLOWED",
    );
  });

  test("refuses a redirect into the cloud metadata service", async () => {
    // The classic bypass, and the reason validation is inside the hop loop.
    await expectCode(
      () => resolver().resolve(`${origin}/redirect-to-metadata`, ctx),
      "SOURCE_NOT_ALLOWED",
    );
  });

  test("refuses a redirect without a Location header", async () => {
    await expectCode(
      () => resolver().resolve(`${origin}/redirect-no-location`, ctx),
      "FETCH_FAILED",
    );
  });
});

describe("readCapped", () => {
  test("rejects a response with no body", async () => {
    const response = new Response(null, { status: 200 });
    await expectCode(() => readCapped(response, 1024), "FETCH_FAILED");
  });

  test("rejects an empty body", async () => {
    await expectCode(() => readCapped(new Response(new Uint8Array(0)), 1024), "FETCH_FAILED");
  });

  test("returns the exact bytes when under the cap", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const out = await readCapped(new Response(payload), 1024);
    expect([...out]).toEqual([1, 2, 3, 4, 5]);
  });

  test("rejects at exactly one byte over the cap", async () => {
    await expectCode(() => readCapped(new Response(new Uint8Array(11)), 10), "SOURCE_TOO_LARGE");
  });

  test("accepts a body of exactly the cap", async () => {
    const out = await readCapped(new Response(new Uint8Array(10)), 10);
    expect(out.byteLength).toBe(10);
  });

  test("reassembles multi-chunk bodies in order", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.enqueue(new Uint8Array([5]));
        controller.close();
      },
    });
    const out = await readCapped(new Response(stream), 1024);
    expect([...out]).toEqual([1, 2, 3, 4, 5]);
  });
});
