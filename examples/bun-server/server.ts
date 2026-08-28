/**
 * A complete bun-img endpoint.
 *
 *   bun examples/bun-server/server.ts
 *   open http://localhost:3000
 *
 * No Sharp, no libvips, no native install step.
 */
import { createImageServer } from "bun-img/server";

const images = createImageServer({
  path: "/_image",

  local: { root: new URL("./public/", import.meta.url).pathname },

  // Remote sources stay disabled unless patterns are listed — there is no
  // wildcard, and an empty list means off.
  // remote: { patterns: [{ protocol: "https", hostname: "images.example.com" }] },

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

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/_image/*": images.handler,
    "/_image": images.handler,

    "/metrics": () =>
      Response.json(images.metrics.snapshot(), {
        headers: { "cache-control": "no-store" },
      }),

    "/": async () => {
      const { srcset } = await import("bun-img");
      const responsive = srcset("/hero.png", {
        widths: [320, 640, 1024, 1920],
        sizes: "(max-width: 768px) 100vw, 1024px",
      });

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
   <code>/metrics</code></p>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  },
});

const caps = await images.engine.capabilities();
console.log(`bun-img listening on http://localhost:${server.port}`);
console.log(`  encode: ${caps.encode.join(", ")}`);
console.log(`  decode: ${caps.decode.join(", ")}`);
console.log(`  backend: ${caps.backend} · bun ${caps.bunVersion} · ${caps.platform}`);
