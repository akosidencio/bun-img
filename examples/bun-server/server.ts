/**
 * A complete bun-img endpoint.
 *
 *   bun examples/bun-server/server.ts     serve it
 *   open http://localhost:3000
 *
 *   bun examples/bun-server/smoke.ts      check it still works, remote included
 *
 * No Sharp, no libvips, no native install step.
 *
 * `images` is exported and the server only starts under `import.meta.main`, so
 * the smoke check drives this exact configuration rather than a copy of it that
 * can drift.
 */
import { createImageServer } from "bun-img/server";

export const images = createImageServer({
  path: "/_image",

  local: { root: new URL("./public/", import.meta.url).pathname },

  /**
   * Remote sources are off until patterns are listed — there is no wildcard and
   * no way to say "any host", because an image endpoint that fetches arbitrary
   * URLs is an SSRF proxy.
   *
   * Two live hosts, chosen because they behave differently and both have to
   * work:
   *
   *   - `images.unsplash.com` answers `HEAD` with a `Last-Modified`, so a warm
   *     cache is served without downloading the image again.
   *   - `picsum.photos` 302s to `fastly.picsum.photos`, which returns **no
   *     validator at all**. Identity cannot be established up front, so those
   *     requests quietly take the slow path instead of breaking.
   *
   * The redirect target needs its own entry: every hop is revalidated against
   * this list from scratch. That is the whole point — an allowlisted host that
   * redirects to `169.254.169.254` must not be followed.
   *
   * A local origin cannot be demonstrated here. `localhost` and IP literals are
   * refused before DNS even runs, by design, so a self-contained offline demo
   * of remote sources is not possible — see `test/sources/remote.test.ts`,
   * which stubs DNS to get a hostile origin onto loopback.
   *
   * For object storage: list the bucket host the same way. Presigned URLs work
   * as-is — an AWS SigV4, GCS, CloudFront or Azure SAS signature is stripped
   * from the cache identity, so a URL reissued every 15 minutes keeps hitting
   * the same entry, while an ordinary `?v=2` stays part of it.
   *
   *   { protocol: "https", hostname: "my-bucket.s3.ap-southeast-1.amazonaws.com" }
   *   { protocol: "https", hostname: "*.cloudfront.net", pathname: "/img/**" }
   */
  remote: {
    patterns: [
      { protocol: "https", hostname: "images.unsplash.com" },
      { protocol: "https", hostname: "picsum.photos" },
      { protocol: "https", hostname: "fastly.picsum.photos" },
    ],
  },

  cache: {
    memory: { maxSize: "128MB" },
    disk: { directory: new URL("./.cache/", import.meta.url).pathname, maxSize: "1GB" },
    negative: { ttl: 60_000 },
  },

  concurrency: { transforms: 8, maxPending: 256 },

  // Per-request logging is a development convenience. Left on under load it is
  // also a surprising amount of I/O — and if stdout is a pipe nobody drains,
  // the server blocks on `write` and stops serving entirely.
  logger:
    process.env.NODE_ENV === "production"
      ? undefined
      : (line) => console.log(JSON.stringify(line)),
});

/** Allowlisted above. Bare URLs — bun-img does the resizing, not the origin. */
export const UNSPLASH = "https://images.unsplash.com/photo-1506744038136-46273834b3fb";
export const PICSUM = "https://picsum.photos/800/600";

const server = import.meta.main ? Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/_image/*": images.handler,
    "/_image": images.handler,

    "/metrics": () =>
      Response.json(images.metrics.snapshot(), {
        headers: { "cache-control": "no-store" },
      }),

    "/": async () => {
      const { imageUrl, srcset } = await import("bun-img");
      const responsive = srcset("/hero.png", {
        widths: [320, 640, 1024, 1920],
        sizes: "(max-width: 768px) 100vw, 1024px",
      });

      // The same call, given an absolute URL. `srcset` emits the query form for
      // remote sources on its own — a URL's `//` cannot survive being encoded
      // as path segments, so the operation-path form would mangle it.
      const remote = srcset(UNSPLASH, {
        widths: [320, 640, 1024],
        sizes: "(max-width: 768px) 100vw, 1024px",
      });
      const redirected = imageUrl(PICSUM, { width: 640 });

      return new Response(
        `<!doctype html>
<meta charset="utf-8">
<title>bun-img</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 70ch; margin: 4rem auto; padding: 0 1.5rem; }
  img { width: 100%; height: auto; border-radius: 4px; }
  code { background: #eee; padding: 0.1em 0.35em; border-radius: 3px; }
</style>
<h1>bun-img</h1>
<p>Served by <code>bun-img/server</code> on Bun ${Bun.version}. No Sharp, no libvips.</p>
<img src="${responsive.src}" srcset="${responsive.srcset}" sizes="${responsive.sizes}"
     width="1920" height="1080" alt="Example" loading="lazy" decoding="async">
<p>Try: <code>/_image/w_800,q_75/hero.png</code> ·
   <code>/_image/w_400,f_webp/hero.png</code> ·
   <code>/metrics</code></p>

<h2>Remote source</h2>
<p>Fetched from <code>images.unsplash.com</code>, allowlisted above, then resized
   and re-encoded here. Reload: the second request is served from cache after a
   <code>HEAD</code>, without downloading the original again.</p>
<img src="${remote.src}" srcset="${remote.srcset}" sizes="${remote.sizes}"
     width="1024" height="683" alt="Remote example" loading="lazy" decoding="async">

<h2>Remote source, behind a redirect</h2>
<p><code>picsum.photos</code> redirects to <code>fastly.picsum.photos</code>, which
   is allowlisted separately because every hop is revalidated. It sends no
   <code>ETag</code> and no <code>Last-Modified</code>, so identity cannot be
   established up front and the request takes the slow path — working, just
   without the cheap cache hit.</p>
<img src="${redirected}" width="640" height="480" alt="Redirected example"
     loading="lazy" decoding="async">
<p>Watch the log lines: <code>x-image-cache</code> is <code>MISS</code> then
   <code>HIT</code>.</p>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  },
}) : null;

if (server) {
  const caps = await images.engine.capabilities();
  console.log(`bun-img listening on http://localhost:${server.port}`);
  console.log(`  encode: ${caps.encode.join(", ")}`);
  console.log(`  decode: ${caps.decode.join(", ")}`);
  console.log(`  backend: ${caps.backend} · bun ${caps.bunVersion} · ${caps.platform}`);
}
