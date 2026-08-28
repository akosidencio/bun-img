# bun-img × Astro

An Astro **local image service**. Astro hands `transform()` the bytes and takes
bytes back — no HTTP, no Sharp, no libvips.

```js
// astro.config.mjs
import { defineConfig } from "astro/config";

export default defineConfig({
  image: {
    service: { entrypoint: "bun-img/astro" },
  },
});
```

`<Image />` and `<Picture />` from `astro:assets` keep working unchanged.

```astro
---
import { Image, Picture } from "astro:assets";
import hero from "../assets/hero.png";
---

<Image src={hero} width={800} alt="Hero" />

<Picture src={hero} widths={[320, 640, 900]} formats={["webp"]} alt="Hero" />
```

## Run Astro under Bun

```sh
bun --bun astro build
bun --bun astro dev
```

The engine needs `Bun.Image`, and Astro's build runs the image service in the
same process it starts in. Under plain Node the transform fails with
`CouldNotTransformImage`, which is Astro wrapping our runtime guard.

## Exact widths, not quantized

The HTTP endpoint quantizes widths onto an allowed list, because a public URL
space is otherwise a cache-cardinality attack. The Astro service turns that
**off** by default.

Astro writes the author's declared width straight into the markup — `<Image
width={300} />` becomes `width="300"` — and separately asks us for the bytes.
Snapping 300 up to 320 would leave the attribute disagreeing with the file: a
layout bug that nothing reports. Astro also hashes each transform to its own
file, so the cardinality pressure the quantizer exists to relieve does not apply.

Pass `quantize: true` through `image.service.config` if you want it back.

## What Astro asks for that Bun cannot do

**`fit`.** Astro's vocabulary is CSS `object-fit`; Bun has only `fill` and
`inside` and cannot crop at all.

| Astro | bun-img |
|---|---|
| `fill` | `fill` |
| `contain` | `inside` |
| `cover`, `none`, `scale-down` | `inside`, with a one-time warning |

`cover` has no honest equivalent — substituting `fill` would distort the image,
so it falls back to `inside`. Pair it with CSS `object-fit: cover` if you need
the crop.

**`format`.** `webp`, `png`, `jpeg`/`jpg` work everywhere. `avif` is accepted but
encodes nowhere on Linux, so the service returns WebP and *reports* WebP —
reporting `avif` while returning WebP bytes would make Astro write a file with
the wrong extension. `svg` is rejected at validation.

## Configuration

Anything the engine accepts goes through `image.service.config`:

```js
export default defineConfig({
  image: {
    service: {
      entrypoint: "bun-img/astro",
      config: {
        defaults: { quality: 80 },
        limits: { maxPixels: 40_000_000 },
      },
    },
  },
});
```
