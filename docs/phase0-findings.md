# Phase 0 — Kill gate findings

**Date:** 2026-08-28
**Verdict:** **GO** — all three kill criteria cleared.
**Host:** Bun 1.4.0 · `linux/x86_64` · `oven/bun:1.4-slim` (glibc 2.41) · 8 CPU · 3.8 GB ·
`Bun.Image.backend === "bun"` (the Linux default) · compared against Sharp 0.34.5

**All numbers in this document are Linux/amd64.** Linux is the deployment target, so it is the
only platform reported. Figures measured on other platforms are not published: they varied
enough to produce a materially different — and misleading — story about performance.

Reproduce, in one command:

```sh
docker run --rm --platform linux/amd64 \
  -v "$PWD":/src:ro -v "$PWD/benchmarks/results-linux":/out \
  oven/bun:1.4-slim sh /src/benchmarks/linux/run.sh
```

Raw results in `benchmarks/results-linux/*.json`.

---

## Gate criteria

The plan said: **stop** if WebP is >15% larger at equal DSSIM, **or** warm throughput is <0.5×
Sharp, **or** peak RSS is >2× Sharp at equal concurrency.

| Criterion | Threshold | Measured | |
|---|---|---|---|
| WebP bytes at matched SSIM | ≤ +15% mean | **+1.9% / +4.1% / +3.0%** (SSIM 0.96 / 0.98 / 0.99) | **PASS** |
| Warm throughput vs Sharp | ≥ 0.5× | **1.12× / 1.11× / 0.77×** at 8 in-flight | **PASS** |
| Peak RSS vs Sharp | ≤ 2× | **0.69×** (156 MB vs 227 MB) | **PASS** |

WebP is at parity — both engines link libwebp, and the gate was really asking whether Bun ships
a crippled build or drives the encoder with bad defaults. It does neither.

**Throughput is parity, not a win.** Bun is marginally ahead on JPEG sources and behind on PNG
decode. There is no "faster than Sharp" claim to make here. Where Bun is clearly ahead is cold
start and memory.

---

## Q1 — Capability matrix

See [capability-matrix.md](./capability-matrix.md). Summary: **JPEG, PNG and WebP are the only
formats that encode.** HEIC and AVIF encode on neither backend. Setting `backend: "system"`
changes nothing on Linux — there is no OS codec behind it.

Decode is narrower than it looks, and does not follow encode:

| Container | Decode |
|---|---|
| jpeg, png, webp | OK |
| gif | OK (first frame only) |
| **tiff** | `ERR_IMAGE_FORMAT_UNSUPPORTED` |
| **avif** | `ERR_IMAGE_FORMAT_UNSUPPORTED` |

This settles open question 5: **do not attempt AVIF in v0.1**, in either direction. An AVIF
source is refused outright, so **input formats are capability-gated exactly like output
formats**, and the probe has to ask about each direction separately rather than inferring one
from the other.

---

## Q2 — Encoder quality (the actual gate)

Method: resize to 800px with each engine, emit a lossless PNG reference from *that engine's own*
resampler, sweep encoder quality 40–95, compute SSIM against that reference, then interpolate
the bytes needed to hit fixed SSIM targets.

Comparing each encoder against its own resampler output isolates encoder quality from resampler
quality. Comparing bytes at a matched `quality:` number would be meaningless — the two scales
are not the same scale.

### WebP — bun vs sharp, bytes at matched SSIM

| | SSIM 0.96 | SSIM 0.98 | SSIM 0.99 |
|---|---|---|---|
| mean | **+1.9%** | +4.1% | +3.0% |
| worst | +6.6% | +10.5% | +3.5% |

Parity, as expected from a shared libwebp.

### JPEG — the weaker encoder

| | SSIM 0.96 | SSIM 0.98 | SSIM 0.99 |
|---|---|---|---|
| mean | **+12.3%** | +9.9% | +5.6% |
| worst | **+28.3%** (smooth landscape) | +18.6% | +5.8% |

| Fixture | SSIM 0.96 | SSIM 0.98 |
|---|---|---|
| landscape-1080p | 13K vs 10K · +28.0% | 19K vs 17K · +13.9% |
| landscape-4k | 13K vs 10K · +28.3% | 18K vs 15K · +18.6% |
| detail-1080p | 38K vs 37K · +3.1% | 62K vs 60K · +2.3% |
| detail-4k | 43K vs 39K · +10.0% | 68K vs 65K · +4.6% |
| gradient-1080p | 78K vs 71K · +9.6% | 142K vs 122K · +15.7% |
| gradient-4k | 76K vs 73K · +4.5% | 138K vs 131K · +5.6% |
| chroma-1080p | 134K vs 122K · +9.9% | 195K vs 171K · +14.0% |
| chroma-4k | 135K vs 129K · +5.0% | 200K vs 192K · +4.4% |

Inside the ≤15% mean gate, but visibly weaker, and the worst case is bad: smooth photographic
content costs Bun ~28% more bytes at SSIM 0.96. The likely cause is that Sharp defaults
`optimiseCoding: true` (optimized Huffman tables), typically worth 5–8%, plus better default
chroma handling. Bun exposes no equivalent knob.

**Consequence for the design:** JPEG is the *compatibility* fallback, not a quality choice.
`format=auto` prefers WebP strongly, and the docs state plainly that a client which only
accepts JPEG pays a real byte penalty relative to Sharp.

### Resampler agreement

Bun's `lanczos3` vs Sharp's `lanczos3`, lossless, same target width: SSIM 0.99590–0.99929. The
two resamplers agree closely enough that geometry is not a differentiator. Bun's resize quality
is fine.

---

## Q3 — Throughput

800px WebP q75, warm, ratio is bun/sharp:

| Workload | conc 1 | conc 4 | conc 8 | conc 16 | conc 32 |
|---|---|---|---|---|---|
| 1080p JPEG (165 KB) | 1.39× | 1.01× | **1.12×** | 0.98× | 0.92× |
| 4K JPEG (2.9 MB) | 1.46× | 1.13× | **1.11×** | 0.98× | 0.86× |
| 2560px PNG (4.4 MB) | 1.00× | 0.98× | **0.77×** | 1.03× | 1.01× |

Parity-to-slightly-ahead on JPEG sources; behind on PNG decode. Comfortably above the 0.5× gate,
and comfortably short of a performance claim.

**Cold start** — fresh process to first completed transform — is where Bun wins clearly:

| | bun | sharp | ratio |
|---|---|---|---|
| cold start | **253 ms** | 536 ms | **0.47×** |
| baseline RSS | **28 MB** | 65 MB | 0.43× |

Sharp is expensive to load: libvips and its dependency chain have to be dlopen'd. For serverless
or frequently-recycled containers this matters more than steady-state throughput does.

---

## Q4 — Alpha to JPEG

**Answer: it neither flattens nor rejects — it ignores alpha.**

On a soft radial-alpha PNG, the fully-transparent corner came back as `rgb(201,169,168)` — the
source colour underneath — where Sharp composited onto black (`rgb(0,0,0)`).

Bun drops the alpha channel and encodes the RGB planes as they are. Since the RGB under
transparent pixels is arbitrary — it depends entirely on whichever encoder wrote the source — the
output is **unpredictable across sources**. A logo could come out with a black box, a white box,
or ghost fringing, with nothing in the API to control it.

This confirms and sharpens plan §6.5: `fallbackFor()` routes `png`/`gif`/`bmp` sources to
**PNG**, never JPEG, and the reason is stronger than "alpha handling is unverified" — it is
*verified and unpredictable*. WebP is unaffected: `bun.webp()` preserved alpha at 4 channels.

---

## Q5 — Install footprint

Measured in the container: `bun install sharp@0.34.5` on `linux/x64` lands **34 MB across 8
packages**, 5 of them `@img/*`. The npm registry's unpacked figures undercount this
substantially (they sum to ~19.4 MB).

| Package | Unpacked |
|---|---|
| `sharp` | 0.92 MB |
| `@img/sharp-linux-x64` | 0.41 MB |
| `@img/sharp-libvips-linux-x64` | **17.77 MB** |
| **Actually installed, linux-x64** | **34 MB, 8 packages** |

`bun-img` adds **zero** native dependencies and zero bytes of libvips. The Docker layer delta
follows directly: ~34 MB plus the install step, removed. Not transformative on its own, but it
eliminates the architecture-specific-binary class of deployment failure entirely, which was the
spec's actual motivation.

---

## Q6 — Memory

3840×2160 JPEG to 800px WebP, 8 in-flight, 40 transforms, median of 3 fresh processes per
engine:

| Engine | Baseline RSS | Peak RSS | Settled RSS | ops/s |
|---|---|---|---|---|
| bun | 28 MB | **156 MB** | **48 MB** | 16.9 |
| sharp | 65 MB | **227 MB** | **207 MB** | 14.6 |

Peak ratio 0.69× — comfortably inside the 2× gate. The settled figure is the more striking one:
after identical load, Sharp holds **207 MB** where Bun releases back to **48 MB**. On a
memory-capped container that gap matters more than the peak does.

Spec P0 ("no catastrophic memory growth under sustained concurrency") was checked directly with
a 600-transform run:

| After | bun RSS floor |
|---|---|
| 100 | 95 MB |
| 300 | 122 MB |
| 600 | 63 MB |

Floor drift over 600 transforms: **−32.8 MB**. No leak. **Spec P0 satisfied.**

---

## R10 — the cache key, and a correction

The plan argued `backend` belongs in the cache key because geometry kernels differ.
`backend-bench.ts` appeared to confirm it dramatically — SSIM 0.980–0.990 between the two
backends' outputs, which I reported as "visibly different images".

**That figure was wrong, and inflated by about 21×.** It compared two independently *WebP
q75-encoded* outputs, folding lossy encoding noise from both sides into what was supposed to be
a geometry measurement. `backend-geometry.ts` isolates it properly with lossless PNG on both
sides.

And on Linux the answer is simpler still:

| Fixture | lossless SSIM | bytes differ |
|---|---|---|
| landscape-1080p | 1.00000 | **no** |
| detail-1080p | 1.00000 | **no** |
| gradient-1080p | 1.00000 | **no** |
| chroma-4k | 1.00000 | **no** |

**On Linux the two backends emit byte-identical output.** `backend: "system"` has no OS codecs
to fall back on, so both settings take the same Highway path.

So the field is **inert on Linux**. It stays in the cache key for one narrower reason: a cache
store shared with a platform that *does* have OS codecs would otherwise return entries the
running backend never produced. Keeping it costs nothing; the justification is cross-platform
cache coherence, not any visible difference on the deployment target.

---

## What is still unverified

1. **arm64.** Only `linux/amd64` was run. arm64 is a common deployment target and needs real
   hardware, not emulation, to time meaningfully.
2. **musl.** Only glibc 2.41 (Debian) was tested. Sharp has a separate
   `@img/sharp-libvips-linuxmusl-*` build; Bun's static codecs should be unaffected, but this is
   untested.
3. **JPEG encoder gap.** Whether the ~12% mean penalty is Huffman optimization specifically, and
   whether Bun plans a knob for it.

---

## Decisions carried into Phase 1

1. **GO.** Build the core.
2. **AVIF is out of v0.1, in both directions** — probed and exposed, never a listed feature.
   AVIF and TIFF *input* are capability-gated too, since Linux refuses to decode either. Closes
   open question 5.
3. **`fallbackFor()` never routes an alpha source to JPEG** — PNG only. Closes open question 3.
4. **`format=auto` prefers WebP strongly**, and the JPEG byte penalty vs Sharp is documented
   rather than hidden.
5. **`backend` and `bunVersion` stay in the cache key**, justified by cross-platform cache
   coherence rather than by any on-platform difference.
6. **Default `transforms` concurrency stays `max(2, cpus)`** — both engines plateau near core
   count.
7. **Phase 6 benchmark claim.** *"Native image optimization for Bun without Sharp or libvips"* is
   supportable, with measured parity on WebP bytes. **No "faster than Sharp" headline.** What is
   defensible: a 2.1× faster cold start, a 4× smaller settled memory footprint, and 34 MB of
   native dependencies removed.
8. **`backend-bench.ts` is superseded by `backend-geometry.ts`** for the geometry question.
