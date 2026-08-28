# bun-img

**Sharp-free image optimization and delivery for Bun.** Resize, convert and
serve JPEG, PNG and WebP with Bun's native image pipeline — no libvips, no
native install step, no architecture-specific binaries.

[![npm](https://img.shields.io/npm/v/bun-img.svg)](https://www.npmjs.com/package/bun-img)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](https://www.npmjs.com/package/bun-img)
[![bun](https://img.shields.io/badge/bun-%E2%89%A5%201.4-black.svg)](https://bun.sh)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](#license)

`bun-img` is an image optimization engine and HTTP image endpoint for the
[Bun](https://bun.sh) runtime. It replaces
[Sharp](https://sharp.pixelplumbing.com) and libvips with `Bun.Image`, and plugs
into `next/image` and `astro:assets` without changing your components.

```sh
bun add bun-img
```

```ts
import { createImageServer } from "bun-img/server";

const images = createImageServer({
  local: { root: "./public" },
  cache: { memory: { maxSize: "256MB" }, disk: { directory: ".cache/images" } },
});

Bun.serve({
  routes: { "/_image/*": images.handler, "/_image": images.handler },
});
```

```
GET /_image/w_800,q_75/hero.jpg
GET /_image/w_400,f_auto/hero.jpg
GET /_image?url=hero.jpg&w=320&q=75
```

## Features

- **Zero dependencies.** No Sharp, no libvips, no `@img/*` platform binaries, no
  postinstall step — removing ~34 MB and an entire class of Docker build failure.
- **JPEG, PNG and WebP** encoding, with resize, EXIF auto-orientation and
  `withoutEnlargement`.
- **Automatic format negotiation** from the `Accept` header, with `Vary` sent
  only when it genuinely applies.
- **Native blur placeholders** — a ThumbHash `data:` URL in one call, a drop-in
  `blurDataURL` for `next/image`.
- **Responsive `srcset` generation** from a browser-safe entrypoint that touches
  no Bun API.
- **Two-tier caching** — a byte-accounted memory LRU in front of a crash-safe
  disk cache with atomic writes and LRU eviction.
- **Single-flight coalescing.** A hundred concurrent requests for one image
  perform one transform, not a hundred.
- **Bounded concurrency** with fast load shedding: `QUEUE_FULL` → 503 with
  `Retry-After`, never an unbounded queue.
- **SSRF-hardened remote fetching** — allowlist, pre- and post-DNS address
  classification, per-redirect re-validation, and a streaming byte cap.
- **Path-traversal-safe local sources**, contained by `realpath` so symlink
  escapes are caught.
- **Conditional requests** — `If-None-Match` → `304`, with RFC 9110 weak
  comparison.
- **`next/image` and `astro:assets` adapters** that keep each framework's own
  component API.
- **Hooks, metrics and structured logs**, with source URLs kept out of metric
  labels and query strings redacted from log lines.

## Next.js

```ts
// next.config.ts
import { withBunImage } from "bun-img/next";

export default withBunImage({
  images: { deviceSizes: [640, 828, 1080, 1920], imageSizes: [64, 128, 256] },
});
```

```ts
// image-loader.ts
export { default } from "bun-img/next/loader";
```

```ts
// app/%5Fimage/[[...path]]/route.ts
import { createNextImageRoute } from "bun-img/next";

export const { GET, HEAD } = createNextImageRoute({
  local: { root: "./public" },
  nextImages: { deviceSizes: [640, 828, 1080, 1920], imageSizes: [64, 128, 256] },
});
```

`<Image />` keeps working unchanged. Serve with `bun --bun next start`. The
folder is `%5Fimage`, not `_image` — App Router excludes underscore-prefixed
folders from routing. See [NEXT.md](./NEXT.md).

## Astro

```js
// astro.config.mjs
export default defineConfig({
  image: { service: { entrypoint: "bun-img/astro" } },
});
```

`<Image />` and `<Picture />` from `astro:assets` keep working unchanged. Build
with `bun --bun astro build`. See [ASTRO.md](./ASTRO.md).

## URL protocol

Two spellings, one meaning, one cache key:

```
/_image/w_800,q_75,f_webp/hero.jpg        canonical
/_image/w_800/q_75/f_webp/hero.jpg        segment form
/_image?url=/hero.jpg&w=800&q=75&f=webp   query form
```

Operations: `w`, `h`, `fit` (`inside` / `fill`), `q`, `f`
(`auto` / `jpeg` / `png` / `webp` / `avif` / `heic`), `enlarge`, `orient`.

```ts
import { imageUrl, srcset } from "bun-img/url";

srcset("/hero.jpg", {
  widths: [320, 640, 1280],
  sizes: "(max-width: 768px) 100vw, 1280px",
});
```

## Entrypoints

| Import | What it is |
|---|---|
| `bun-img` | the engine — transform, sources, cache, concurrency |
| `bun-img/url` | URL building and `srcset`; no Bun APIs, runs in the browser |
| `bun-img/server` | the HTTP endpoint, `Request` in and `Response` out |
| `bun-img/next` | `next/image` loader and route handler |
| `bun-img/astro` | an Astro local image service |

## Performance

Measured on **linux/amd64** against Sharp 0.34.5 — the deployment target, and
the only platform these numbers come from.

| | vs Sharp |
|---|---|
| WebP bytes at matched SSIM | **+1.9%** — parity |
| JPEG bytes at matched SSIM | **+12% mean, +28% worst** |
| Warm throughput | **1.11×** JPEG, **0.77×** PNG decode — parity |
| Cold start | **0.47×** — 253 ms vs 536 ms |
| Settled RSS after load | **48 MB vs 207 MB** |
| Native install | **0 MB vs 34 MB** |

**There is no "faster than Sharp" claim.** Throughput is parity, and bun-img is
behind on PNG decode. The wins are cold start, memory footprint, and having no
native dependencies at all. JPEG is the *compatibility* fallback rather than a
quality choice — prefer WebP.

Under sustained load, 200 concurrent users over 5 minutes served **1,782,525
requests with zero failures** and flat memory (74 → 70 MB).

Method, fixtures and raw numbers are in the repository under `docs/` and
`benchmarks/`, and are reproducible with one command.

## Limitations

These are limits of Bun's image pipeline, not missing work:

- **No cropping and no `cover` fit.** Bun offers `fill` and `inside`, with no
  `extract`. Fixed-ratio thumbnails need `fit: "inside"` plus client-side
  `object-fit: cover`. This is the largest functional gap versus Sharp.
- **No AVIF, in either direction.** Encoding needs an OS AV1 encoder, which
  Linux has no path to. AVIF *input* is refused as well, as is TIFF — decode
  support does not follow encode support, so both are probed at runtime.
- **No animation.** GIF decodes the first frame only.
- **No sharpen, blur, composite, watermark, arbitrary rotation or EXIF control.**

The engine probes encode *and* decode support at runtime, on the machine
actually serving traffic, rather than assuming either.

## Roadmap

| | |
|---|---|
| **Nuxt** | a Nuxt Image provider — `<NuxtImg>` without IPX or Sharp |
| **SvelteKit** | an `enhanced:img`-compatible image service |
| **React & Svelte components** | framework-neutral `<Image />` with `srcset`, lazy loading and blur placeholders |
| **Hono & Elysia** | drop-in middleware for the endpoint |
| **S3 / R2 sources** | fetch originals from object storage |
| **S3 / R2 / Redis cache tiers** | shared caching for multi-instance deployments |
| **Signed URLs** | HMAC-signed transforms for publicly exposed endpoints |
| **Presets** | named transforms, e.g. `/_image/p_avatar/users/42.jpg` |
| **Prometheus & OpenTelemetry** | first-class metrics export |

Cropping and AVIF are not on the roadmap — both wait on Bun.

## Requirements

Bun **>= 1.4**, for `Bun.Image`.

`bun-img/url` runs anywhere — Node, browsers, edge runtimes — because it only
builds strings. Everything else needs Bun, and says so clearly rather than
failing obscurely:

```
bun-img requires Bun; this is Node.js 22.22.2.

  Image processing uses Bun.Image and cannot run anywhere else.
  URL building works everywhere:  import { imageUrl, srcset } from "bun-img/url"

  Running through a framework? Name the runtime explicitly:
    bun --bun next start
    bun --bun astro build
```

The check runs when you construct an engine, not when you import — so
`next build` and Astro's config load, which both evaluate these modules under
Node without creating an engine, keep working.

There is deliberately **no install-time script**. npm and pnpm hide postinstall
output by default, so a warning there would be invisible to most people while
costing every consumer a lifecycle script — and "no postinstall step" is one of
the reasons to use this package. `engines` names Bun instead.

## License

MIT © bun-img contributors. See [LICENSE](./LICENSE).
