# bun-img

**Sharp-free image delivery for Bun** — JPEG, PNG and WebP, resize, orientation,
and native blur placeholders. No libvips, no native install step, no
architecture-specific binaries.

```ts
import { createImageEngine } from "@bun-img/core";

const images = createImageEngine({
  local: { root: "./public" },
});

const out = await images.optimize({
  src: "hero.jpg",
  transform: { width: 800, quality: 75 },
  accept: request.headers.get("accept"),
});
// out.body → Blob · out.format → "webp" · out.etag → "bimg_…"
```

Requires **Bun ≥ 1.4** with `Bun.Image`. Node.js is not supported and is not
planned.

---

## Status

| Phase | | |
|---|---|---|
| 0 | Kill gate | **passed** |
| 1 | Core transform & URL protocol | **done** |
| 2 | Sources & safety | **done** |
| 3 | Cache, coalescing, concurrency | next |
| 4 | HTTP server | |
| 5 | Astro adapter | |
| 6 | Benchmarks & docs | *v0.1 ships here* |
| 7–8 | Nuxt, Next, components, server plugins | |

Nothing is published to npm yet. Full plan and rationale in
[PLAN.md](./PLAN.md).

## Why

Framework image pipelines reach for Sharp, which drags in libvips: ~34 MB of
platform-specific native packages, a per-architecture install, and a recurring
class of Docker build failures. Bun ships an image pipeline in the runtime.
This is the delivery layer around it.

The honest version of the pitch, measured on **linux/amd64** against Sharp 0.34.5 — the deployment target, and
the only platform we publish numbers for:

| | vs Sharp |
|---|---|
| WebP bytes at matched SSIM | **+1.9%** — parity |
| JPEG bytes at matched SSIM | **+12% mean, +28% worst** — Bun's weaker encoder |
| Warm throughput | **1.11×** on JPEG, **0.77×** on PNG decode — parity |
| Cold start | **0.47×** — 253 ms vs 536 ms |
| Peak RSS | **0.69×** — 156 MB vs 227 MB |
| Settled RSS after load | **48 MB vs 207 MB** |
| Native install | **0 MB vs 34 MB** |

**There is no "faster than Sharp" claim.** Throughput is parity, and Bun is
behind on PNG decode. What Bun wins on is cold start, memory, and having no
native dependencies at all.

Method and raw numbers: [docs/phase0-findings.md](./docs/phase0-findings.md).

## What it will not do

These are runtime limits, not roadmap gaps:

- **No cropping and no `cover` fit.** Bun offers `fill` and `inside`, with no
  `extract`. Fixed-ratio thumbnails need `fit: "inside"` plus client-side
  `object-fit: cover`. This is the biggest functional gap versus Sharp.
- **No AVIF, in either direction.** Encoding needs an OS AV1 encoder, which
  Linux has no path to. AVIF *input* is refused as well, as is TIFF — decode
  support does not follow encode support, so both are probed at runtime.
- **No animation, sharpen, blur, composite, watermark, arbitrary rotation, or
  EXIF control.**

Full matrix: [docs/capability-matrix.md](./docs/capability-matrix.md).

## Runtime

Bun-only, and Bun-native throughout: `Bun.Image`, `Bun.file`, `Bun.dns.lookup`,
`Bun.CryptoHasher`, `Bun.serve`. Two `node:` imports remain — `node:path` and
`realpath` — because Bun ships no equivalent for either. Under Bun those are
Bun's own Zig implementations; importing them involves no Node.js and installs
nothing. A test asserts that list stays exactly two entries long, so the next
`node:` import has to be a deliberate decision.

## Packages

```
packages/
  core/       @bun-img/core     transform, URL protocol, sources, cache keys
```

`@bun-img/core` has **zero dependencies**, asserted by a test. Adapters will
depend on core; core will never depend on a framework.

Planned: `@bun-img/server`, `@bun-img/astro`, then Nuxt and Next.

## URL protocol

Two spellings, one meaning, one cache key:

```
/_image/w_800,q_75,f_webp/hero.jpg        canonical
/_image/w_800/q_75/f_webp/hero.jpg        segment form
/_image?url=/hero.jpg&w=800&q=75&f=webp   query form
```

Operations: `w`, `h`, `fit`, `q`, `f`, `enlarge`, `orient`.

```ts
import { imageUrl, srcset } from "@bun-img/core/url";

srcset("/hero.jpg", {
  widths: [320, 640, 1280],
  sizes: "(max-width: 768px) 100vw, 1280px",
});
```

The `url` entrypoint touches no Bun API, so adapters can build markup in the
browser while every pixel operation stays server-side.

## Safety

Local sources are contained by **realpath**, after symlinks resolve — a lexical
`startsWith(root)` check happily serves a symlink pointing at `/etc`. Missing and
forbidden files return the same error, so the endpoint cannot be used to probe
the filesystem.

Remote sources run a five-step chain — shape, allowlist, pre-DNS, post-DNS
address classification, then a streaming byte cap — and **repeat all of it on
every redirect hop**. Skipping the allowlist on redirects is the classic bypass:
an allowlisted host 302s to `169.254.169.254`. Remote is disabled unless
patterns are configured; there is no wildcard.

Width and quality quantization are **on by default**. They are the only real
defence against cache-cardinality floods, and signed URLs are post-v1.

## Two behaviours that will surprise you

**An alpha source never auto-negotiates to JPEG.** Bun neither flattens alpha nor
rejects it — it drops the channel and keeps whatever RGB sits underneath, which
is arbitrary and varies by source encoder. A logo can come out with a black box,
a white box, or ghost fringing. Bun exposes no `hasAlpha`, so the engine decides
by container and routes possibly-transparent sources to PNG or WebP. An explicit
`f=jpeg` is still honoured.

**Cache keys include the backend and Bun version.** On Linux the two backends
emit byte-identical output, so the field is inert there. It stays in the key so
that a cache store shared with a platform that *does* have OS codecs cannot
return entries the running backend never produced — cross-platform coherence, at
no cost on the deployment target.

## Development

```sh
bun install
bun test packages/            # 340 tests
bunx tsc --noEmit -p tsconfig.json
```

Benchmarks (needs Sharp, installed only under `benchmarks/`):

```sh
cd benchmarks && bun install
bun prepare-fixtures.ts
bun quality-bench.ts && bun throughput-bench.ts && bun mem-bench.ts
```

On Linux, in one command:

```sh
docker run --rm --platform linux/amd64 \
  -v "$PWD":/src:ro -v "$PWD/benchmarks/results-linux":/out \
  oven/bun:1.4-slim sh /src/benchmarks/linux/run.sh
```

## License

MIT
