import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createImageServer } from "../../src/server/handler.ts";
import { etagMatches } from "../../src/server/headers.ts";
import { classifySource, redactSource } from "../../src/server/observability.ts";
import type { SourceResolver } from "../../src/index.ts";
import { ImageError } from "../../src/index.ts";

let root: string;
let scratch: string;

/** A solid image of known dimensions, built with Bun.Image — no Sharp anywhere. */
async function makeImage(width: number, height: number): Promise<Uint8Array> {
  const seed = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    ),
    (c) => c.charCodeAt(0),
  );
  return await new Bun.Image(seed).resize(width, height, { fit: "fill" }).png({ compressionLevel: 1 }).bytes();
}

beforeAll(async () => {
  scratch = join(tmpdir(), `bun-img-server-${Bun.randomUUIDv7()}`);
  root = join(scratch, "public");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "hero.png"), await makeImage(1200, 600));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const server = () => createImageServer({ local: { root }, cache: { memory: {} } });
const get = (url: string, init?: RequestInit) => new Request(`http://localhost${url}`, init);

describe("routing and methods", () => {
  test("serves an image", async () => {
    const response = await server().handle(get("/_image/w_320,f_webp/hero.png"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(Number(response.headers.get("content-length"))).toBeGreaterThan(0);
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  test("serves the query protocol too", async () => {
    const response = await server().handle(get("/_image?url=hero.png&w=320&f=webp"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
  });

  test("HEAD returns the same headers with no body", async () => {
    const s = server();
    const head = await s.handle(get("/_image/w_320,f_webp/hero.png", { method: "HEAD" }));
    const full = await s.handle(get("/_image/w_320,f_webp/hero.png"));

    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(head.headers.get("content-length")).toBe(full.headers.get("content-length"));
    expect(head.headers.get("etag")).toBe(full.headers.get("etag"));
    expect(head.headers.get("content-type")).toBe(full.headers.get("content-type"));
  });

  test("OPTIONS advertises the allowed methods", async () => {
    const response = await server().handle(get("/_image/hero.png", { method: "OPTIONS" }));
    expect(response.status).toBe(204);
    expect(response.headers.get("allow")).toContain("GET");
  });

  test("rejects write methods with 405 and Allow", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const response = await server().handle(get("/_image/hero.png", { method }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toContain("GET");
    }
  });

  test("rejects a path outside the endpoint", async () => {
    const response = await server().handle(get("/not-images/hero.png"));
    expect(response.status).toBe(400);
  });

  test("honours a custom base path", async () => {
    const s = createImageServer({ local: { root }, path: "/img" });
    expect((await s.handle(get("/img/w_320/hero.png"))).status).toBe(200);
    expect((await s.handle(get("/_image/w_320/hero.png"))).status).toBe(400);
  });
});

describe("caching headers", () => {
  test("a versioned source gets immutable", async () => {
    // Local files have mtime+size, so the engine can detect a change and the
    // promise is honest.
    const response = await server().handle(get("/_image/w_320,f_webp/hero.png"));
    const cc = response.headers.get("cache-control")!;
    expect(cc).toContain("immutable");
    expect(cc).toContain("max-age=31536000");
  });

  test("an unversioned source gets a bounded TTL instead of immutable", async () => {
    // Claiming immutable here would pin stale bytes in shared caches for a year
    // with no way to flush them.
    const unversioned: SourceResolver = {
      name: "unversioned",
      supports: () => true,
      async resolve() {
        return { data: await makeImage(400, 400), identity: { id: "no-version" }, kind: "custom" as const };
      },
    };
    const s = createImageServer({ resolvers: [unversioned] });
    const cc = (await s.handle(get("/_image/w_320,f_webp/x.png"))).headers.get("cache-control")!;
    expect(cc).not.toContain("immutable");
    expect(cc).toContain("stale-while-revalidate");
  });

  test("Vary: Accept only when Accept chose the format", async () => {
    const s = server();

    const auto = await s.handle(
      get("/_image/w_320,f_auto/hero.png", { headers: { accept: "image/webp" } }),
    );
    expect(auto.headers.get("vary")).toBe("Accept");

    // An explicit format is content-addressed: one URL, one cache entry.
    const explicit = await s.handle(get("/_image/w_320,f_webp/hero.png"));
    expect(explicit.headers.get("vary")).toBeNull();
  });

  test("cache policy is configurable", async () => {
    const s = createImageServer({
      local: { root },
      cacheControl: { immutableMaxAge: 60 },
    });
    expect((await s.handle(get("/_image/w_320/hero.png"))).headers.get("cache-control")).toContain(
      "max-age=60",
    );
  });
});

describe("conditional requests", () => {
  test("If-None-Match matching the ETag returns 304 with no body", async () => {
    const s = server();
    const first = await s.handle(get("/_image/w_320,f_webp/hero.png"));
    const etag = first.headers.get("etag")!;

    const second = await s.handle(
      get("/_image/w_320,f_webp/hero.png", { headers: { "if-none-match": etag } }),
    );

    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);
    expect(second.headers.get("cache-control")).toBe(first.headers.get("cache-control"));
  });

  test("a stale If-None-Match returns the image", async () => {
    const response = await server().handle(
      get("/_image/w_320,f_webp/hero.png", { headers: { "if-none-match": '"stale"' } }),
    );
    expect(response.status).toBe(200);
  });

  test("If-None-Match: * always matches", async () => {
    const response = await server().handle(
      get("/_image/w_320,f_webp/hero.png", { headers: { "if-none-match": "*" } }),
    );
    expect(response.status).toBe(304);
  });

  test("weak and strong forms of one ETag match", async () => {
    // RFC 9110 weak comparison: refusing this would make every revalidation
    // re-download bytes the client already has.
    const s = server();
    const etag = (await s.handle(get("/_image/w_320,f_webp/hero.png"))).headers.get("etag")!;
    const weak = await s.handle(
      get("/_image/w_320,f_webp/hero.png", { headers: { "if-none-match": `W/${etag}` } }),
    );
    expect(weak.status).toBe(304);
  });

  test("a list of ETags matches on any member", async () => {
    const s = server();
    const etag = (await s.handle(get("/_image/w_320,f_webp/hero.png"))).headers.get("etag")!;
    const response = await s.handle(
      get("/_image/w_320,f_webp/hero.png", { headers: { "if-none-match": `"other", ${etag}` } }),
    );
    expect(response.status).toBe(304);
  });
});

describe("etagMatches", () => {
  test("handles the cases the handler relies on", () => {
    expect(etagMatches('"a"', '"a"')).toBe(true);
    expect(etagMatches('W/"a"', '"a"')).toBe(true);
    expect(etagMatches('"a"', 'W/"a"')).toBe(true);
    expect(etagMatches("*", '"anything"')).toBe(true);
    expect(etagMatches('"a", "b"', '"b"')).toBe(true);
    expect(etagMatches('"a"', '"b"')).toBe(false);
    expect(etagMatches(null, '"a"')).toBe(false);
    expect(etagMatches("", '"a"')).toBe(false);
  });
});

describe("errors", () => {
  test("a missing file is 404 and is cacheable", async () => {
    const response = await server().handle(get("/_image/w_320/missing.png"));
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("max-age=");
    expect(await response.json()).toMatchObject({ error: "SOURCE_NOT_FOUND" });
  });

  test("traversal is 404, indistinguishable from missing", async () => {
    const s = server();
    const traversal = await s.handle(get("/_image/w_320/..%2F..%2Fetc%2Fpasswd"));
    const missing = await s.handle(get("/_image/w_320/nope.png"));
    expect(traversal.status).toBe(missing.status);
    expect(await traversal.json()).toEqual(await missing.json());
  });

  test("a malformed request is 400", async () => {
    expect((await server().handle(get("/_image/w_abc/hero.png"))).status).toBe(400);
    expect((await server().handle(get("/_image?url=hero.png&width=320"))).status).toBe(400);
  });

  test("QUEUE_FULL is 503 with Retry-After and is never cached", async () => {
    // Transient, and about our load rather than the content: caching it would
    // extend a brief spike into minutes of failure for images that are fine.
    const widths = Array.from({ length: 30 }, (_, i) => 200 + i * 10);
    const s = createImageServer({
      local: { root },
      widths,
      concurrency: { transforms: 1, maxPending: 1 },
    });

    const responses = await Promise.all(
      widths.map((w) => s.handle(get(`/_image/w_${w},f_webp/hero.png`))),
    );
    const shed = responses.find((r) => r.status === 503);

    expect(shed).toBeDefined();
    expect(shed!.headers.get("retry-after")).toBe("1");
    expect(shed!.headers.get("cache-control")).toBe("no-store");
  }, 30_000);

  test("a 5xx is never cached", async () => {
    const broken: SourceResolver = {
      name: "broken",
      supports: () => true,
      async resolve() {
        throw new ImageError("INTERNAL_ERROR", 500, "boom");
      },
    };
    const response = await createImageServer({ resolvers: [broken] }).handle(get("/_image/x.png"));
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("an unexpected throw becomes a 500, not a crash", async () => {
    const exploding: SourceResolver = {
      name: "exploding",
      supports: () => true,
      async resolve() {
        throw new TypeError("not an ImageError");
      },
    };
    const response = await createImageServer({ resolvers: [exploding] }).handle(get("/_image/x.png"));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "INTERNAL_ERROR" });
  });
});

describe("debug headers", () => {
  test("are present by default outside production", async () => {
    const response = await server().handle(get("/_image/w_320,f_webp/hero.png"));
    expect(response.headers.get("x-image-width")).toBe("320");
    expect(response.headers.get("x-image-format")).toBe("webp");
    expect(response.headers.get("x-image-source")).toBe("local");
    expect(response.headers.get("x-image-duration")).toMatch(/ms$/);
  });

  test("can be turned off, while cache provenance stays", async () => {
    const s = createImageServer({ local: { root }, cache: { memory: {} }, debugHeaders: false });
    const response = await s.handle(get("/_image/w_320,f_webp/hero.png"));
    expect(response.headers.get("x-image-width")).toBeNull();
    // Says whether *we* had the bytes; reveals nothing about the source.
    expect(response.headers.get("x-image-cache")).toBe("MISS");
  });

  test("report cache provenance across requests", async () => {
    const s = server();
    const first = await s.handle(get("/_image/w_320,f_webp/hero.png"));
    const second = await s.handle(get("/_image/w_320,f_webp/hero.png"));
    expect(first.headers.get("x-image-cache")).toBe("MISS");
    expect(second.headers.get("x-image-cache")).toBe("HIT");
  });
});

describe("observability", () => {
  test("redacts query strings, which can carry signed URLs and tokens", () => {
    expect(redactSource("https://cdn.example.com/a.png?sig=secret&expires=123")).toBe(
      "https://cdn.example.com/a.png",
    );
    expect(redactSource("images/a.png?token=abc")).toBe("images/a.png");
    expect(redactSource("http://[bad")).toBe("[unparseable]");
  });

  test("classifies sources without inspecting their contents", () => {
    expect(classifySource("https://cdn.example.com/a.png")).toBe("remote");
    expect(classifySource("hero.png")).toBe("local");
    expect(classifySource(undefined)).toBe("bytes");
  });

  test("metrics count hits, misses and bytes", async () => {
    const s = server();
    await s.handle(get("/_image/w_320,f_webp/hero.png"));
    await s.handle(get("/_image/w_320,f_webp/hero.png"));
    await s.handle(get("/_image/w_320/missing.png"));

    const snapshot = s.metrics.snapshot();
    expect(snapshot.requestsTotal).toBe(3);
    expect(snapshot.cacheMissesTotal).toBe(1);
    expect(snapshot.cacheHitsTotal).toBe(1);
    expect(snapshot.errorsTotal.SOURCE_NOT_FOUND).toBe(1);
    expect(snapshot.byFormat.webp).toBe(2);
    expect(snapshot.bySourceKind.local).toBe(3);
    expect(snapshot.outputBytesTotal).toBeGreaterThan(0);
  });

  test("timings cover real work only, not cache hits", async () => {
    // Including hits would drag every percentile toward zero and hide the
    // latency that actually matters.
    const s = server();
    await s.handle(get("/_image/w_320,f_webp/hero.png"));
    for (let i = 0; i < 5; i++) await s.handle(get("/_image/w_320,f_webp/hero.png"));
    expect(s.metrics.snapshot().transformDurationMs.count).toBe(1);
  });

  test("metrics labels never include a source URL", async () => {
    // A label from user input is an unbounded series count.
    const s = server();
    await s.handle(get("/_image/w_320,f_webp/hero.png"));
    const serialized = JSON.stringify(s.metrics.snapshot());
    expect(serialized).not.toContain("hero.png");
    expect(serialized).not.toContain(root);
  });

  test("fires hooks", async () => {
    const seen: string[] = [];
    const s = createImageServer({
      local: { root },
      cache: { memory: {} },
      hooks: {
        onRequest: () => seen.push("request"),
        onCacheMiss: () => seen.push("miss"),
        onCacheHit: () => seen.push("hit"),
        onTransform: () => seen.push("transform"),
        onError: () => seen.push("error"),
      },
    });

    await s.handle(get("/_image/w_320,f_webp/hero.png"));
    await s.handle(get("/_image/w_320,f_webp/hero.png"));
    await s.handle(get("/_image/w_320/missing.png"));

    expect(seen).toEqual(["request", "miss", "transform", "request", "hit", "request", "error"]);
  });

  test("logs are structured and redacted", async () => {
    const lines: Record<string, unknown>[] = [];
    const s = createImageServer({
      local: { root },
      logger: (line) => lines.push(line),
    });

    await s.handle(get("/_image/w_320,f_webp/hero.png?sig=secret"));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "image.request", format: "webp", source_type: "local" });
    expect(JSON.stringify(lines[0])).not.toContain("secret");
  });

  test("metrics reset", async () => {
    const s = server();
    await s.handle(get("/_image/w_320,f_webp/hero.png"));
    s.metrics.reset();
    expect(s.metrics.snapshot().requestsTotal).toBe(0);
  });
});

describe("content negotiation over HTTP", () => {
  test("a modern client gets WebP", async () => {
    const response = await server().handle(
      get("/_image/w_320,f_auto/hero.png", { headers: { accept: "image/webp,image/png" } }),
    );
    expect(response.headers.get("content-type")).toBe("image/webp");
  });

  test("a PNG source is never auto-negotiated to JPEG", async () => {
    const response = await server().handle(
      get("/_image/w_320,f_auto/hero.png", { headers: { accept: "image/jpeg" } }),
    );
    expect(response.headers.get("content-type")).not.toBe("image/jpeg");
  });
});
