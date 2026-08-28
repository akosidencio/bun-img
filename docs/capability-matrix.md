# Bun.Image capability matrix

Measured 2026-08-28 · Bun 1.4.0 · `linux/x86_64` · `oven/bun:1.4-slim` (glibc 2.41) · 8 CPU.

Linux is the deployment target and the only platform reported here. Default backend on Linux is
**`"bun"`**.

Reproduce: `bun benchmarks/behaviour-probe.ts` inside `oven/bun:1.4-slim`, or the one-command
runner in `benchmarks/linux/run.sh`.

## Encode

| Format | `backend: "bun"` | `backend: "system"` |
|---|---|---|
| jpeg | encode | encode |
| png | encode | encode |
| webp | encode | encode |
| heic | `ERR_IMAGE_FORMAT_UNSUPPORTED` | `ERR_IMAGE_FORMAT_UNSUPPORTED` |
| avif | `ERR_IMAGE_FORMAT_UNSUPPORTED` | `ERR_IMAGE_FORMAT_UNSUPPORTED` |

**JPEG, PNG and WebP are the only formats that encode.** Asking for
`backend: "system"` changes nothing — there is no OS codec behind it on Linux. AVIF needs an OS
AV1 encoder, which Linux has no path to at all.

The two backends also emit **byte-identical** output here, since both take the same Highway
geometry path.

## Decode

| Container | Result | `metadata().format` |
|---|---|---|
| jpeg | OK | `jpeg` |
| png | OK | `png` |
| webp | OK | `webp` |
| gif | OK (first frame only) | `gif` |
| **tiff** | `ERR_IMAGE_FORMAT_UNSUPPORTED` | — |
| **avif** | `ERR_IMAGE_FORMAT_UNSUPPORTED` | — |

**Decode does not follow encode, and is narrower than expected.** TIFF and AVIF sources are
refused outright. So input formats are capability-gated exactly like output formats, and the
engine probes each direction separately rather than inferring one from the other — including for
formats it cannot itself produce, which is why `src/probe-samples.ts` ships four tiny 2×2
samples.

This is also why the probe runs on the machine that is actually serving traffic. Codec
availability is a property of the build and the OS, not something to be assumed from
documentation.

## Behavioural notes

- **Alpha to JPEG diverges from Sharp.** `bun.jpeg()` on an RGBA source drops the alpha channel
  and keeps whatever RGB sits underneath; Sharp composites onto black. Measured on a soft
  radial-alpha fixture: Bun returned `rgb(201,169,168)` in the fully-transparent corner, Sharp
  returned `rgb(0,0,0)`. Because the RGB under transparent pixels is arbitrary — it depends on
  whichever encoder wrote the source — the output is unpredictable. **Never route an alpha source
  to JPEG.**
- **Alpha survives WebP**: 4 channels, `hasAlpha: true`.
- **`placeholder()` is deterministic** across repeated calls on identical input (766 chars for a
  1200×800 fixture), so it is safe to cache and safe to fold into an ETag.
- **`gif` decodes the first frame only** — there is no animated output path.
