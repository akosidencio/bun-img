# @bun-img/core

Bun-native image transformation. No Sharp, no libvips, no native install step.

```ts
import { createImageEngine } from "@bun-img/core";

const images = createImageEngine();

const out = await images.optimize({
  source: Bun.file("./public/hero.jpg"),
  transform: { width: 800, quality: 75 },
  accept: request.headers.get("accept"),
});

// out.body      Blob
// out.width     800
// out.format    "webp"
// out.etag      "bimg_…"
```

Zero dependencies, enforced by a test. Framework adapters depend on core; core
depends only on Bun.

## What it does

Resize, orient, and re-encode to **JPEG, PNG and WebP** — the only three formats
Bun can encode on Linux. Plus a canonical URL protocol, cache keys, content
negotiation, `srcset` generation, safe local and remote sources, and native blur
placeholders.

## What it does not do

- **No cropping, and no `cover` fit.** Bun offers `fill` and `inside` only, with
  no `extract` operation. Fixed-ratio thumbnails need `fit: "inside"` plus
  client-side `object-fit: cover`.
- **No AVIF, in either direction.** Encoding needs an OS AV1 encoder, which
  Linux has no path to; AVIF *input* is refused too, as is TIFF. Decode support
  does not follow encode support, so both are probed at runtime.
- **No animation** (GIF decodes the first frame only), no sharpen, blur,
  composite, watermark, arbitrary rotation, or EXIF control.

## Honest performance notes

Measured on **linux/amd64** against Sharp 0.34.5. Linux is the deployment
target and the only platform we publish numbers for.

- **WebP is at parity** — +1.9% bytes at matched SSIM. Both link libwebp.
- **JPEG costs more.** +12% mean bytes at matched SSIM, worst case +28% on
  smooth photographic content. Sharp defaults to optimized Huffman tables; Bun
  exposes no equivalent. **JPEG is the compatibility fallback, not a quality
  choice** — prefer WebP.
- **Throughput is parity, not a win.** 1.11× on JPEG sources, 0.77× on PNG
  decode. There is no "faster than Sharp" claim.
- **Cold start and memory are the real wins.** 253 ms vs 536 ms to first
  transform, and 48 MB settled RSS vs Sharp's 207 MB after identical load.

Full method and raw numbers: `docs/phase0-findings.md`.

## URL protocol

Two spellings, one meaning, one cache key:

```
/_image/w_800,q_75,f_webp/hero.jpg      canonical
/_image/w_800/q_75/f_webp/hero.jpg      segment form
/_image?url=/hero.jpg&w=800&q=75&f=webp query form
```

```ts
import { imageUrl, srcset, parseImageRequest } from "@bun-img/core/url";

imageUrl("/hero.jpg", { width: 800, quality: 75 });
// "/_image/w_800,q_75/hero.jpg"

srcset("/hero.jpg", { widths: [320, 640, 1280], sizes: "(max-width: 768px) 100vw, 1280px" });
// { src, srcset, sizes, width }
```

The `url` entrypoint touches no Bun API, so adapters can build markup in the
browser while every pixel operation stays server-side.

Operations: `w`, `h`, `fit` (`inside`/`fill`), `q`, `f`
(`auto`/`jpeg`/`png`/`webp`/`avif`/`heic`), `enlarge` (`0`/`1`), `orient`
(`0`/`1`).

## Defaults worth knowing

| Setting | Default | Why |
|---|---|---|
| `formats` | `["webp", "jpeg"]` | AVIF encodes nowhere reachable |
| `widths` | `320…1920` | quantization is **on** — the only real defence against cache-cardinality floods |
| `qualities` | `[60, 75, 85]` | same |
| `limits.maxPixels` | `40_000_000` | Bun's own default is 268 M, which is Sharp parity, not safety |
| `defaults.fit` | `"inside"` | Bun's resize default is `"fill"` |
| `remote.patterns` | `[]` — remote **disabled** | there is no wildcard default |

Every Bun option is passed explicitly on every call, so a change to Bun's
defaults cannot silently alter output bytes.

## Two behaviours that will surprise you

**An alpha source never auto-negotiates to JPEG.** Bun does not flatten alpha and
does not reject it — it drops the channel and keeps whatever RGB sits
underneath, which is arbitrary and varies by whichever encoder wrote the source.
A logo could come out with a black box, a white box, or ghost fringing. Since
Bun exposes no `hasAlpha`, the engine decides by container: PNG, GIF, WebP,
AVIF, HEIC and BMP sources are treated as possibly-transparent and routed to PNG
or WebP. Requesting `f=jpeg` explicitly is still honoured — it is your call.

**Cache keys include the backend and the Bun version.** On Linux the two
backends emit byte-identical output, so the field is inert there. It stays in the
key because a cache store shared with a platform that has OS codecs would
otherwise return entries the running backend never produced. Cross-platform cache
coherence, at no cost on the deployment target.

## Requirements

Bun >= 1.4 with `Bun.Image`. Node.js is not supported and is not planned.
