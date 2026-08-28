# bun-img — Spec Review & Development Plan

**Reviewed spec:** *Technical Specification — Bun-Native Image Optimization Engine* v0.1 (draft)
**Project name:** `bun-img`
**Language:** TypeScript (strict), Bun-only runtime
**Plan date:** 2026-08-27
**Verified against:** Bun 1.4.0, `bun-types@1.4.0`, `linux/amd64` (`oven/bun:1.4-slim`), Sharp 0.34.5

> **All measurements in this plan are linux/amd64.** Linux is the deployment target, and the
> only platform reported.
>
> **Phase 0 kill gate: PASSED, 2026-08-28.** WebP bytes at matched SSIM are within **+1.9%** of
> Sharp (gate: +15%); warm throughput is **1.11–1.12×** (gate: 0.5×); peak RSS is **0.69×**
> (gate: 2×). Full results in [docs/phase0-findings.md](docs/phase0-findings.md) and
> [docs/capability-matrix.md](docs/capability-matrix.md).
> **Throughput is parity, not a win** — Bun trails at 0.77× on PNG decode. The real wins are a
> 2.1× faster cold start and a 4× smaller settled RSS.

---

## 0. How this plan was produced

The spec is written against `Bun.Image` in the abstract. Before planning, the real API was
probed on Bun 1.4.0 — type declarations read from `bun-types@1.4.0/bun.d.ts`, behaviour
confirmed by running transformations. **Ten of the spec's assumptions are wrong or
incomplete**, and two of its "future" items are actually free today.

Measured baseline (3840x2160 JPEG resized to 800px WebP q75, lanczos3, linux/amd64, 8 CPU):

| in-flight | bun ops/sec | p50 |
|---|---|---|
| 1 | 4.5 | 227 ms |
| 2 | 6.3 | 291 ms |
| 4 | 10.8 | 311 ms |
| 8 | 15.5 | 477 ms |
| 16 | 16.0 | 828 ms |
| 32 | 14.7 | 974 ms |

`Bun.Image` already runs the decode/transform/encode pipeline on its own worker thread pool.
Throughput plateaus near CPU count; past that only latency grows. **Our concurrency limiter
does not create parallelism — it bounds memory and keeps p99 predictable.**

---

## 1. The real `Bun.Image` surface (v1.4.0)

```ts
class Image {
  static backend: "system" | "bun";
  constructor(input: string | ArrayBuffer | NodeJS.TypedArray | Blob, options?: {
    maxPixels?: number;   // default 268_402_689  (0x3FFF^2, Sharp parity)
    autoOrient?: boolean; // default true
  });

  resize(width: number, height?: number, options?: {
    filter?: "nearest" | "box" | "bilinear" | "linear" | "cubic" | "mitchell"
           | "lanczos2" | "lanczos3" | "mks2013" | "mks2021";  // default lanczos3
    fit?: "fill" | "inside";                                   // default "fill"
    withoutEnlargement?: boolean;
  }): this;
  rotate(degrees: number): this;   // multiples of 90 only
  flip(): this; flop(): this;
  modulate(o: { brightness?: number; saturation?: number }): this;

  jpeg(o?: { quality?: number; progressive?: boolean }): this;
  png(o?: { compressionLevel?: number; palette?: boolean; colors?: number; dither?: boolean }): this;
  webp(o?: { quality?: number; lossless?: boolean }): this;
  heic(o?: { quality?: number }): this;   // macOS / Windows+HEIF only
  avif(o?: { quality?: number }): this;   // OS AV1 encoder only

  bytes(): Promise<Uint8Array>;
  blob(): Promise<Blob>;
  buffer(): Promise<Buffer>;
  dataurl(): Promise<string>;
  toBase64(): Promise<string>;
  write(dest): Promise<number>;
  metadata(): Promise<{ width: number; height: number; format: Format }>;
  placeholder(as?: "dataurl"): Promise<string>;   // ThumbHash data: URL

  readonly width: number;   // -1 until first awaited terminal
  readonly height: number;
}

type Format = "jpeg" | "png" | "webp" | "heic" | "avif" | "bmp" | "tiff" | "gif";
// bmp / tiff / gif are decode-only

type ErrorCode =
  | "ERR_IMAGE_FORMAT_UNSUPPORTED" | "ERR_IMAGE_TOO_MANY_PIXELS"
  | "ERR_IMAGE_DECODE_FAILED" | "ERR_IMAGE_ENCODE_FAILED"
  | "ERR_IMAGE_UNKNOWN_FORMAT" | "ERR_INVALID_STATE";
```

Execution order is fixed regardless of call order:
`autoOrient -> rotate -> flip/flop -> resize -> modulate`. Chainables overwrite.
Source ICC profile is preserved through re-encode to JPEG/PNG/WebP.

---

## 2. Spec review — findings

### R1 · AVIF is not deliverable on Linux. This changes the product story. [critical]

`avif()` requires an **OS AV1 encoder**, which Linux has no path to. The default backend there
is `"bun"`, which rejects HEIC and AVIF outright — and switching to `"system"` changes nothing,
because there is no OS codec behind it.
Measured on linux/amd64:

```text
                 backend="bun"   backend="system"
encode jpeg           OK               OK
encode png            OK               OK
encode webp           OK               OK
encode heic          FAIL             FAIL
encode avif          FAIL             FAIL
```

Setting `backend: "system"` changes nothing — there is no OS codec behind it on Linux.
JPEG/PNG/WebP are the only formats that encode.

Consequences for the spec:

- §11's negotiation algorithm opens with `if AVIF requested AND supported` — **dead branch in
  production**.
- §32's example config `formats: ["avif", "webp", "jpeg"]` is misleading as a default.
- Sharp *can* encode AVIF on Linux (libaom/libheif). So AVIF is a **genuine feature gap vs
  Sharp**, not a "capability nuance" as §10 frames it.

**Decision:** WebP is the terminal modern format for v0.1. AVIF is *detected, never assumed*.
A capability probe runs once at engine construction; a configured-but-unavailable format logs
one warning and is dropped from negotiation. An explicit `f=avif` request must never 500 —
policy choice between `406` and silent downgrade, default downgrade.

### R2 · There is no crop, and no `cover` fit. [critical]

Bun offers `fit: "fill" | "inside"` only. There is **no `extract` / crop / `cover`**. The
spec's §47 `avatar` preset (`width: 128, height: 128, fit: "fill"`) will **stretch and distort**
any non-square source — the worst possible failure for avatars.

This is the largest functional gap vs Sharp for real applications: avatars, card thumbnails,
OG images, and fixed-ratio grids all want crop-to-fill.

**Decision:** Non-Goals must state "no cropping" explicitly. Remove the `avatar` preset from
the roadmap, or redefine it as `fit: "inside"` plus client-side `object-fit: cover`. Revisit if
Bun ships an extract op.

### R3 · Other missing ops to declare up front

No `sharpen`, `blur`, `composite`/watermark, `flatten`/background, `trim`, `negate`, arbitrary
rotation (90-degree multiples only), text rendering, or explicit EXIF/metadata-strip control.
`gif` decodes the first frame only — **no animated output**. **TIFF and AVIF decode both reject
on Linux** (verified), so decode support does not follow encode support and input formats need
capability-gating of their own.

### R4 · Blur placeholders are free today — pull them into v0.1. [win]

§31 defers placeholders to "later v0.x" and proposes hand-rolling a 16-24px image.
`Bun.Image.prototype.placeholder()` already returns a ThumbHash-rendered
`data:image/png;base64,...` — around 800 chars, and deterministic within a Bun version. That is
a drop-in `blurDataURL` for `next/image` and a headline feature at near-zero implementation
cost.

Note it derives from the **source**, not the transform — so it caches per source identity,
independent of width/quality/format. It costs a full decode, so caching is mandatory.

### R5 · `transformTimeout` cannot cancel anything. [critical]

There is no abort path into a running `Bun.Image` pipeline. A timeout can only stop *waiting*.

The dangerous version of this bug: on timeout you release the concurrency slot, admit another
transform, and now oversubscribe the worker pool — latency collapses and the queue cascades.

**Rule:** the semaphore slot is held until the underlying promise settles, win or lose. The
timeout affects only the HTTP response. The real defences are `maxPixels` and `maxSourceBytes`,
which are enforced *before* allocation.

### R6 · `maxPixels` defaults to 268,402,689 — always pass it explicitly

Confirmed enforced in both directions:

```text
new Bun.Image(src, { maxPixels: 100 }).metadata()                    -> ERR_IMAGE_TOO_MANY_PIXELS
new Bun.Image(src, { maxPixels: 10e6 }).resize(20000, 20000).jpeg()  -> ERR_IMAGE_TOO_MANY_PIXELS
```

Header-checked before pixel-buffer allocation, and re-checked on resize output. This is the
cheapest and strongest single defence in the system. Spec §21's 40M is a sane default.

### R7 · Bun's resize `fit` default is `"fill"`; the spec's engine default is `"inside"`

Never inherit a Bun default. Every option is passed explicitly on every call, so a future
change to Bun's defaults cannot silently alter our output bytes.

### R8 · `Content-Length` cannot enforce `maxSourceBytes`

The constructor accepts only fully-buffered input — there is no streaming decode. A hostile
remote can lie about or omit `Content-Length` and stream 5 GB. The fetch layer must read the
body in chunks and abort the moment cumulative bytes exceed the cap. §21/§22 do not say this.

### R9 · `.width` / `.height` report **output** dims after the terminal

Confirmed: 3840x2160 source, `.resize(400, ..., { fit: "inside" })` gives
`after terminal w/h: 400 225`. Before the terminal both are `-1`.

So `OptimizedImage` needs **no extra `metadata()` round-trip** — read them after `bytes()`.
Conversely, `srcset` generation and layout-shift prevention need *source* dims, which do
require a separate `metadata()`; cache that per source alongside the placeholder.

### R10 · The cache key is under-specified — include the backend and Bun version

§14 hashes `engineVersion + sourceIdentity + sourceVersion + normalizedTransform +
negotiatedFormat`. Missing: `Bun.Image.backend` and the Bun version.

**Measured on Linux, the two backends emit byte-identical output** — `backend: "system"` has no
OS codecs to fall back on, so both settings take the same Highway geometry path. The field is
therefore *inert* on the deployment target.

It still belongs in the key, for a narrower reason than the spec review first assumed: a cache
store shared with a platform that *does* have OS codecs would otherwise return entries the
running backend never produced. Cross-platform cache coherence, at zero cost on Linux.

**Key must be:**
`sha256(schemaVersion, bunVersion, backend, sourceIdentity, sourceVersion, normalizedTransform, negotiatedFormat)`

### R11 · Concurrency: right numbers, wrong rationale

See the §0 table — throughput plateaus around 8–16 in-flight on an 8-CPU host and then declines.
Default `transforms: Math.max(2, cpus)` rather than a flat 8, and document that the limiter
exists for memory and tail latency, not throughput.

### R12 · Gaps not addressed by the spec at all

| Gap | Why it matters |
|---|---|
| **Local path traversal** | `local.root` plus a user-supplied path. `../../etc/passwd` is not mentioned anywhere in §20's threat list. Must resolve and assert the realpath stays under root. |
| **`Vary: Accept` vs `immutable`** | §23 sends both `Vary: Accept` and `max-age=31536000, immutable`. That fragments every CDN cache by a high-entropy header. Prefer baking the negotiated format into the URL (the operation-path protocol allows it) and dropping `Vary` on immutable responses. |
| **304 / `If-None-Match`** | Never mentioned. Cheapest win in the whole system. |
| **Negative caching** | A remote 404 or `DECODE_FAILED` re-fetches on every request, becoming self-inflicted DoS amplification against the upstream. Needs a short-TTL error cache. |
| **Disk cache durability** | §15 gives `maxSize: "2GB"` with no eviction algorithm, no crash-safety, no multi-process story. Needs atomic tmp+rename writes and a size index. |
| **Width/quality quantization is optional** | §49/§50 mark these "optional". They are the *only* real defence against cache-cardinality exhaustion, and signed URLs (§48) are post-v1. **Quantization must be ON by default in v0.1.** |

### R13 · Narrow the positioning claim

"`next/image`-class image infrastructure" over-claims while there is no crop and no AVIF.
Honest line, and still a strong one:

> **Sharp-free image delivery for Bun — JPEG/PNG/WebP, resize, orientation, and native blur placeholders.**

The spec's own §37 guidance ("never claim faster than Sharp") is right; extend the same
discipline to feature parity.

### R14 · Ten packages is too many for v0.1

§6 lays out 10 packages while §41 correctly says phase them. v0.1 ships **three**:
`@bun-img/core`, `@bun-img/server`, `@bun-img/astro`, plus a `bun-img` meta-package that
re-exports core and server so `bun add bun-img` works. Cache backends stay inside core until
there is a second remote backend to justify the interface.

### R15 · Adapter ordering is right, difficulty ranking is not

Astro first is correct — it has a real Image Service abstraction (§42). But:

- **Nuxt is the easiest**, not the third: a Nuxt Image provider is a pure URL builder.
- **Next is the most constrained**: `loaderFile` must be a client-safe module with a default
  export receiving only `{ src, width, quality }`. It cannot read engine config at runtime and
  cannot see `Accept`. So `format=auto` must be negotiated **server-side** at the endpoint, and
  the loader emits `f=auto`. This belongs in the adapter contract.

---

## 3. What v0.1 is

> A Bun-only, Sharp-free image transformation and delivery engine: a normalized URL protocol,
> safe local and remote sources, memory and disk caching with request coalescing, bounded
> concurrency, and a Web-standard HTTP handler — plus one framework adapter (Astro) proving the
> core is framework-agnostic.

**In:** JPEG/PNG/WebP · width/height/fit/quality/format/autoOrient/withoutEnlargement ·
placeholders · srcset builder · SSRF + traversal + resource limits · memory and disk cache ·
single-flight · quantized widths/qualities · capability probing · stable error model.

**Out:** crop/cover · AVIF-as-guaranteed · animation · filters/composite · S3 sources · signed
URLs · Prometheus · Next/Nuxt/React/Svelte/Hono/Elysia adapters.

---

## 4. Repository

```text
bun-img/
├── packages/
│   ├── core/            @bun-img/core     transform, URL protocol, cache, capabilities
│   ├── server/          @bun-img/server   Web-standard HTTP handler
│   ├── astro/           @bun-img/astro    Astro Image Service
│   └── bun-img/         bun-img           meta: re-exports core + server
├── benchmarks/          sharp vs bun-img, fixtures, reporter
├── examples/            astro-app, bun-server
├── docs/
├── package.json         workspaces, bun-only
├── tsconfig.base.json   strict, moduleResolution: bundler, types: ["bun-types"]
└── PLAN.md
```

Enforced boundary (spec §40, kept): `@bun-img/core` has **zero** dependencies — not `astro`,
not `next`, not even a cache library. Verified by a test that reads `package.json` and asserts
`dependencies` is empty.

---

## 5. Type surface (core)

```ts
// ── capabilities ────────────────────────────────────────────────────────────
export type ImageFormat = "jpeg" | "png" | "webp" | "avif" | "heic";
export type DecodeFormat = ImageFormat | "bmp" | "tiff" | "gif";

export interface Capabilities {
  bunVersion: string;
  backend: "system" | "bun";
  decode: readonly DecodeFormat[];
  encode: readonly ImageFormat[];   // probed, not assumed
}

// ── transform ───────────────────────────────────────────────────────────────
export interface ImageTransform {
  width?: number;
  height?: number;
  fit?: "inside" | "fill";
  quality?: number;
  format?: "auto" | ImageFormat;
  withoutEnlargement?: boolean;
  autoOrient?: boolean;
}

/** Fully-resolved, canonically ordered. The only thing the cache key hashes. */
export interface NormalizedTransform {
  readonly width: number | null;
  readonly height: number | null;
  readonly fit: "inside" | "fill";
  readonly quality: number;
  readonly format: ImageFormat;      // never "auto" — already negotiated
  readonly withoutEnlargement: boolean;
  readonly autoOrient: boolean;
}

// ── result ──────────────────────────────────────────────────────────────────
export interface OptimizedImage {
  readonly body: Blob;
  readonly width: number;            // output dims, from img.width after terminal
  readonly height: number;
  readonly format: ImageFormat;
  readonly contentType: string;
  readonly size: number;
  readonly etag: string;
  readonly cache: { status: "hit" | "miss" | "coalesced"; key: string };
}

// ── errors ──────────────────────────────────────────────────────────────────
export type ImageErrorCode =
  | "INVALID_REQUEST" | "SOURCE_NOT_ALLOWED" | "SOURCE_NOT_FOUND"
  | "SOURCE_TOO_LARGE" | "IMAGE_TOO_LARGE" | "UNSUPPORTED_FORMAT"
  | "FETCH_TIMEOUT" | "FETCH_FAILED" | "DECODE_FAILED" | "TRANSFORM_FAILED"
  | "ENCODE_FAILED" | "QUEUE_FULL" | "TRANSFORM_TIMEOUT" | "INTERNAL_ERROR";

export class ImageError extends Error {
  constructor(
    readonly code: ImageErrorCode,
    readonly status: number,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ImageError";
  }
}
```

`fit` is deliberately `"inside" | "fill"` and not Sharp's five modes — the type is the
documentation for R2.

---

## 6. Key algorithms

### 6.1 Normalization — one canonical form, one key

```ts
export function normalize(
  t: ImageTransform,
  cfg: ResolvedConfig,
  negotiated: ImageFormat,
): NormalizedTransform {
  return {
    width:  t.width  == null ? null : quantizeWidth(clampDim(t.width, cfg), cfg),
    height: t.height == null ? null : clampDim(t.height, cfg),
    fit:    t.fit ?? cfg.defaults.fit,
    quality: quantizeQuality(t.quality ?? cfg.defaults.quality, cfg),
    format: negotiated,
    withoutEnlargement: t.withoutEnlargement ?? cfg.defaults.withoutEnlargement,
    autoOrient:         t.autoOrient         ?? cfg.defaults.autoOrient,
  };
}
```

Quantization is **on by default** (R12). `w=813` snaps up to the next allowed width; `q=79`
snaps to the nearest allowed quality. `strictWidths: true` rejects with `INVALID_REQUEST`
instead of snapping.

`?w=800&q=75&f=webp` and `?q=75&f=webp&w=800` must produce byte-identical keys — asserted by a
property test over shuffled query orders.

### 6.2 Cache key — includes the backend (R10)

```ts
const KEY_SCHEMA = 1;

export function cacheKey(
  source: SourceIdentity,
  t: NormalizedTransform,
  caps: Capabilities,
): string {
  const canonical = [
    `s${KEY_SCHEMA}`, caps.bunVersion, caps.backend,
    source.id, source.version ?? "-",
    t.width ?? "-", t.height ?? "-", t.fit, t.quality, t.format,
    t.withoutEnlargement ? 1 : 0, t.autoOrient ? 1 : 0,
  ].join(" ");

  const digest = new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
  return `bimg_${digest.slice(0, 32)}`;
}
```

`source.version` is the remote ETag / Last-Modified, or local `mtime + size`. An absent version
means the entry gets a bounded TTL instead of `immutable`, because we cannot detect source
change.

### 6.3 The transform itself — every option explicit (R7)

```ts
async function runTransform(
  input: Uint8Array | string,
  t: NormalizedTransform,
  limits: ResolvedLimits,
): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  let img = new Bun.Image(input, {
    maxPixels: limits.maxPixels,       // never inherit Bun's 268M default (R6)
    autoOrient: t.autoOrient,
  });

  if (t.width != null) {
    img = img.resize(t.width, t.height ?? undefined, {
      fit: t.fit,                      // explicit — Bun defaults to "fill" (R7)
      filter: "lanczos3",
      withoutEnlargement: t.withoutEnlargement,
    });
  }

  img = applyEncoder(img, t.format, t.quality);

  const bytes = await img.bytes();
  if (bytes.byteLength > limits.maxOutputBytes) {
    throw new ImageError("IMAGE_TOO_LARGE", 413, "encoded output exceeds maxOutputBytes");
  }
  return { bytes, width: img.width, height: img.height };  // output dims (R9)
}
```

`resize()` requires a width, so height-only requests are resolved to a width via the cached
source `metadata()` before reaching this function.

### 6.4 Error mapping — codes, never message strings

```ts
const BUN_TO_PUBLIC: Record<string, [ImageErrorCode, number]> = {
  ERR_IMAGE_UNKNOWN_FORMAT:     ["UNSUPPORTED_FORMAT", 415],
  ERR_IMAGE_FORMAT_UNSUPPORTED: ["UNSUPPORTED_FORMAT", 415],
  ERR_IMAGE_TOO_MANY_PIXELS:    ["IMAGE_TOO_LARGE",    413],
  ERR_IMAGE_DECODE_FAILED:      ["DECODE_FAILED",      422],
  ERR_IMAGE_ENCODE_FAILED:      ["ENCODE_FAILED",      500],
  ERR_INVALID_STATE:            ["INTERNAL_ERROR",     500],
  ENOENT: ["SOURCE_NOT_FOUND", 404],
  EACCES: ["SOURCE_NOT_FOUND", 404],   // do not leak permission topology
};
```

`ERR_IMAGE_TOO_MANY_PIXELS` also covers the **256 MiB cap on path-backed inputs** (documented in
Bun's types, absent from the spec), so our message must not claim "too many pixels" verbatim.

### 6.5 Format negotiation (R1) — capability-gated, never optimistic

```ts
export function negotiate(
  requested: "auto" | ImageFormat,
  accept: string | null,
  sourceFormat: DecodeFormat,
  caps: Capabilities,
  cfg: ResolvedConfig,
): ImageFormat {
  if (requested !== "auto") {
    if (caps.encode.includes(requested)) return requested;
    if (cfg.onUnsupportedFormat === "reject") {
      throw new ImageError("UNSUPPORTED_FORMAT", 406, `${requested} not encodable here`);
    }
    return fallbackFor(sourceFormat, caps);     // default: silent downgrade
  }

  const wants = parseAccept(accept);
  for (const f of cfg.formats) {                // preference order, config-driven
    if (caps.encode.includes(f) && wants.has(f)) return f;
  }
  return fallbackFor(sourceFormat, caps);       // jpeg/png passthrough
}
```

`fallbackFor` keeps a compatible source format: `png`/`gif`/`bmp` to `png` (alpha preserved),
everything else to `jpeg`. **Never route an alpha source to JPEG.** Phase 0 measured what
happens: Bun does not flatten and does not reject — it *drops the alpha channel and keeps
whatever RGB sits underneath* (transparent corner returned `rgb(201,169,168)`; Sharp returned
`rgb(0,0,0)`). Since that underlying RGB is arbitrary and depends on whichever encoder wrote
the source, the output is unpredictable across sources, and Bun has no `flatten` op to control
it (R3).

Phase 0 also found the JPEG encoder itself costs ~12% more bytes than Sharp at matched SSIM
(worst case +28% on smooth photographic content), so `cfg.formats` should prefer WebP strongly
and the docs should state the JPEG penalty rather than hide it.

### 6.6 Single-flight and bounded queue (R5)

```ts
class Coalescer {
  #inflight = new Map<string, Promise<OptimizedImage>>();

  run(key: string, fn: () => Promise<OptimizedImage>): Promise<OptimizedImage> {
    const existing = this.#inflight.get(key);
    if (existing) {
      return existing.then(r => ({ ...r, cache: { ...r.cache, status: "coalesced" as const } }));
    }
    const p = fn().finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, p);
    return p;
  }
}

class Semaphore {
  #active = 0;
  #queue: Array<() => void> = [];
  constructor(private limit: number, private maxPending: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.limit && this.#queue.length >= this.maxPending) {
      throw new ImageError("QUEUE_FULL", 503, "transform queue saturated");
    }
    if (this.#active >= this.limit) {
      await new Promise<void>(r => this.#queue.push(r));
    }
    this.#active++;
    try {
      return await fn();          // slot held until settled — see R5
    } finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }
}
```

The response-level timeout wraps the `Coalescer`, **outside** the `Semaphore`, so a timed-out
request stops waiting without releasing a slot the worker still occupies.

### 6.7 Source safety

```ts
// Local: resolve, then assert containment on the REAL path (R12)
async function resolveLocal(rawPath: string, root: string): Promise<string> {
  const decoded = decodeURIComponent(rawPath);
  if (decoded.includes("\0")) {
    throw new ImageError("INVALID_REQUEST", 400, "null byte in path");
  }

  const abs = resolve(root, "." + normalizePath("/" + decoded));
  const realRoot = await realpath(root);
  const real = await realpath(abs).catch(() => {
    throw new ImageError("SOURCE_NOT_FOUND", 404, "not found");
  });

  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    throw new ImageError("SOURCE_NOT_ALLOWED", 403, "outside root");
  }
  return real;   // realpath, so symlink escapes are caught too
}
```

Remote fetch, in order: pattern match, pre-DNS literal-IP check, resolve, post-DNS IP check,
fetch with `redirect: "manual"`, re-validate **every** hop, then the streaming byte cap:

```ts
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) throw new ImageError("FETCH_FAILED", 502, "empty body");

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {                       // Content-Length is untrusted (R8)
      await reader.cancel();
      throw new ImageError("SOURCE_TOO_LARGE", 413, "source exceeds maxSourceBytes");
    }
    chunks.push(value);
  }
  return concat(chunks, total);
}
```

Blocked ranges: `127.0.0.0/8`, `0.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`
(including `169.254.169.254`), `100.64/10` CGNAT, `::1`, `fc00::/7`, `fe80::/10`,
`::ffff:0:0/96` IPv4-mapped, and `.local` / `.internal` suffixes. `maxRedirects: 3`.

---

## 7. HTTP behaviour

```http
HTTP/1.1 200 OK
Content-Type: image/webp
Content-Length: 48192
Cache-Control: public, max-age=31536000, immutable
ETag: "bimg_a3f1..."
X-Image-Cache: HIT
```

Rules the spec omits:

- **`Vary: Accept` only when `f=auto` was actually used.** Explicit-format URLs are
  content-addressed and get no `Vary`, keeping CDN cardinality at 1 (R12).
- **`If-None-Match` to `304`** before any cache read or transform.
- **`immutable` only when `source.version` is known.** Unversioned sources get
  `public, max-age=<ttl>, stale-while-revalidate=<ttl>`.
- **`QUEUE_FULL` to `503` plus `Retry-After: 1`.**
- Error responses carry `Cache-Control: public, max-age=<negativeTtl>` (default 60s) so a
  broken upstream cannot be amplified through us.
- Debug headers (`X-Image-Duration`, `X-Image-Source`, ...) behind `debugHeaders: boolean`,
  defaulting to `process.env.NODE_ENV !== "production"`.

---

## 8. Phases

### Phase 0 — Kill gate · COMPLETE, verdict GO (2026-08-28)

Measured on `linux/amd64` (`oven/bun:1.4-slim`, glibc 2.41, 8 CPU) against Sharp 0.34.5.

| Criterion | Threshold | Measured | |
|---|---|---|---|
| WebP bytes at matched SSIM | ≤ +15% mean | +1.9% | PASS |
| Warm throughput vs Sharp | ≥ 0.5x | 1.11–1.12x JPEG, 0.77x PNG | PASS |
| Peak RSS vs Sharp | ≤ 2x | 0.69x (156 MB vs 227 MB) | PASS |

WebP is at parity because both engines link libwebp. **Throughput is parity, not a win** — Bun
is marginally ahead on JPEG sources and behind on PNG decode. Where it wins clearly is cold
start (253 ms vs 536 ms) and memory: after identical load Sharp settles at 207 MB where Bun
releases back to 48 MB. Sustained 600-transform runs show no RSS growth, satisfying spec P0.
Sharp's Linux install is 34 MB of native packages that `bun-img` does not need.

Four changes to the plan came out of it:

1. **AVIF is out of v0.1, in both directions** — it encodes nowhere, and Linux will not *decode*
   AVIF or TIFF either, so **input formats are capability-gated too**. Closes open question 5.
2. **`fallbackFor()` routes alpha sources to PNG, never JPEG** — Bun ignores alpha rather than
   flattening it, giving unpredictable output. Closes open question 3.
3. **JPEG is the compatibility fallback, not a quality choice** — ~12% mean byte penalty vs
   Sharp, worst case +28%. New; `format=auto` prefers WebP strongly and the docs state it.
4. **No "faster than Sharp" headline.** The defensible claims are cold start, settled memory,
   and 34 MB of native dependencies removed.

R10's conclusion holds but its first measurement did not: I reported the two backends as
producing "visibly different images" (SSIM 0.980–0.990). That number compared two independently
q75-encoded outputs and overstated the geometry difference ~21x. Measured losslessly on Linux
the backends are **byte-identical**. `backend` stays in the cache key for cross-platform
coherence, not for any on-platform difference.

**Still open:** arm64 (only linux/amd64 was run) and musl (only Debian glibc 2.41 tested).

**Deliverables:** [docs/phase0-findings.md](docs/phase0-findings.md),
[docs/capability-matrix.md](docs/capability-matrix.md), `benchmarks/results-linux/*.json`,
nine reproducible benchmark scripts, and a one-command Linux runner at
`benchmarks/linux/run.sh`.

### Phase 1 — Core transform and protocol · COMPLETE (2026-08-28)

`@bun-img/core` ships: capability probe (one-shot, cached per backend, probing **encode and
decode separately**), `normalize`, `cacheKey`, `runTransform`, error mapping, both URL protocols
with a round-trip property test over 630 transforms, `imageUrl()`, `imageQueryUrl()`,
`srcset()`, and `placeholder()`.

**Done:** `optimize()` accepts `Uint8Array`, `ArrayBuffer`, `Blob` and `BunFile` with no server,
no cache and no sources. **183 tests pass on linux/amd64** (`oven/bun:1.4-slim`),
typecheck is clean under `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`,
`dependencies: {}` is asserted by a test, and every Bun option is passed explicitly.

Two bugs the tests caught before they could ship:

1. **`format=auto` could route an alpha source to JPEG.** The auto branch looped over
   `cfg.formats` and would happily pick JPEG for a PNG source whose client only accepted JPEG —
   exactly the unpredictable-output case Phase 0 documented. Fixed by skipping alpha-unsafe
   output formats when the source container can carry alpha. Decided by container, not content,
   because Bun exposes no `hasAlpha`.
2. **`/_image/w_/a.jpg` was silently treated as a source path.** The "unknown key means this is
   the source" rule swallowed a known key with an empty value, turning a 400 into a confusing
   404. Fixed so a known key always reaches the parser.

Also corrected during the work: the cache-key canonical string separates fields with NUL rather
than a space (no field value can contain one, so `{id: "a b", version: "c"}` cannot collide with
`{id: "a", version: "b c"}`), and an absent source version is now distinguishable from one that
is literally `"-"`.

### Phase 2 — Sources and safety · COMPLETE (2026-08-28)

Local resolver with realpath containment; remote resolver running the full chain
(shape, allowlist, pre-DNS, post-DNS address classification, streaming byte cap) and
repeating **all of it on every redirect hop**; `SourceResolver` extension interface; bounded
per-source metadata cache holding dimensions and placeholders.

**Done:** **340 tests pass on linux/amd64.** The security matrix covers the spec's §38 list
plus the traversal and symlink cases it omits: `../` in five spellings, percent-encoded
traversal, null-byte truncation, a symlink to a file outside the root, a path *through* a
symlinked directory, a sibling directory sharing a name prefix, and dotfiles. Remote tests run
against a real hostile origin (`Bun.serve`) with DNS stubbed: redirect loops, over-long chains,
redirects off-allowlist, redirects into `169.254.169.254`, HTML claiming `image/jpeg`, an
endless body with no `Content-Length`, a `Content-Length` that lies in either direction, and
slowloris.

Decisions worth recording:

- **IP parsing is strict on purpose.** `010.0.0.1`, `0x7f.0.0.1`, `2130706433` and `127.1` all
  reach loopback through some resolver, so anything that is not exactly four decimal octets is
  not treated as an IPv4 literal at all. IPv4-mapped (`::ffff:127.0.0.1`) and NAT64
  (`64:ff9b::169.254.169.254`) addresses are unwrapped before classification, or they walk
  straight past the v4 blocklist.
- **Every DNS answer is checked, not just the first.** A hostname with one public and one
  private A record is refused, because which address gets connected to is not ours to choose.
- **Missing and forbidden are the same error.** A distinct 403 confirms a path exists.
- **`*.example.com` does not match the bare apex.** Allowlisting a CDN subdomain should not
  implicitly grant the parent domain.
- **A pattern without a port allows only the protocol default.** An allowlisted host on `:8080`
  may be something entirely different.
- **Residual risk, documented rather than papered over:** between address validation and the
  connection, a name could be re-resolved (DNS rebinding). Bun's `fetch` cannot be pinned to a
  validated IP, and connecting by IP would break TLS verification. `Bun.dns.lookup` caching
  narrows the window without closing it; the bytes still have to decode as an image.

**Runtime note.** Everything uses Bun-native APIs — `Bun.dns.lookup` (which returns *every*
address by default, exactly what the validation rule needs), `Bun.file().stat()`,
`Bun.CryptoHasher`, `Bun.serve`. Two `node:` imports remain, `node:path` and `realpath`,
because Bun ships no equivalent; a test asserts that list stays exactly two entries long.

### Phase 3 — Cache, coalescing, concurrency · 4-5 days

Memory LRU (byte-accounted, not entry-counted); disk cache with atomic tmp+rename, a size
index, and LRU eviction; negative cache; `Coalescer`; `Semaphore` with bounded queue.

**Done when:** 100 concurrent identical requests produce **exactly 1** transform (asserted via a
counting hook); the disk cache survives `SIGKILL` mid-write with no corrupt entries; a
10k-distinct-width flood does not exceed `maxSize`.

### Phase 4 — HTTP server · 3-4 days

`@bun-img/server`: `handle(request): Promise<Response>`, Web APIs only. Conditional requests,
correct `Vary` / `Cache-Control` per §7, `503` plus `Retry-After`, debug headers, hooks and
metrics from spec §34, structured logs from §35 with URL redaction.

**Done when:** `examples/bun-server` serves `/_image/w_800,q_75/hero.jpg`; a 200-VU load test
holds flat RSS for 5 minutes (spec P0).

### Phase 5 — Astro adapter · 2-3 days

`@bun-img/astro` implementing `validateOptions` / `getURL` / `parseURL` / `transform` /
`getHTMLAttributes`. `<Image />` from `astro:assets` unchanged; build-time and SSR paths both
exercised.

**Done when:** `examples/astro-app` builds and serves with `sharp` absent from the lockfile,
asserted by a test that greps the lockfile.

### Phase 6 — Benchmarks and honest README · 2-3 days

The full spec §37 suite, reproducible, one command, results committed as JSON plus a generated
table. README leads with R13's claim and states R1 and R2 as known limitations **above** the
feature list.

**Done when:** a third party can reproduce the numbers from a clean clone.

### v0.1 ships here — `bun add bun-img`

### Phase 7 — Nuxt, then Next · 3-4 days each

Nuxt provider first (pure URL builder, R15). Then the Next `loaderFile` plus `withBunImage()`
config translation, documenting that `f=auto` is negotiated server-side because the loader never
sees `Accept`. `blurDataURL` wired to `placeholder()` (R4) is the adapter's headline feature.

### Phase 8 — Components and server plugins · 4-5 days

`@bun-img/react`, `@bun-img/svelte`, `@bun-img/hono`, `@bun-img/elysia`.

---

## 9. Config, with defaults that are safe rather than permissive

```ts
createImageEngine({
  path: "/_image",

  local: { root: "./public" },

  remote: {
    patterns: [],              // empty = remote disabled. Never a wildcard default.
    maxRedirects: 3,
    timeout: 10_000,
  },

  formats: ["webp", "jpeg"],   // NOT avif-first (R1). Probed and filtered at boot.
  onUnsupportedFormat: "downgrade",

  defaults: { quality: 75, fit: "inside", autoOrient: true, withoutEnlargement: true },

  widths: [320, 480, 640, 768, 1024, 1280, 1536, 1920],
  qualities: [60, 75, 85],
  strictWidths: false,         // false = quantize, true = reject. Quantizing is ON. (R12)

  limits: {
    maxPixels: 40_000_000,
    maxSourceBytes: 20 * 1024 * 1024,
    maxOutputBytes: 20 * 1024 * 1024,
    maxWidth: 8192,
    maxHeight: 8192,
    fetchTimeout: 10_000,
    responseTimeout: 15_000,   // renamed from transformTimeout — it cannot cancel (R5)
  },

  cache: {
    memory: { maxSize: "256MB" },
    disk: { directory: ".cache/images", maxSize: "2GB" },
    negativeTtl: 60_000,
  },

  concurrency: {
    transforms: Math.max(2, navigator.hardwareConcurrency),   // R11
    remoteFetches: 32,
    queue: { maxPending: 256 },
  },
});
```

---

## 10. Runtime guard

```ts
if (typeof Bun === "undefined" || typeof Bun.Image !== "function") {
  throw new Error(
    "bun-img requires Bun >= 1.4 with Bun.Image. " +
    "Node.js is not supported — see docs/compatibility.md",
  );
}
```

URL-building and `srcset` code stay dependency-free and browser-safe, since adapters run them
client-side. Everything touching `Bun.Image` lives behind a server-only entrypoint so a bundler
cannot drag it into a browser chunk.

---

## 11. Open questions

1. ~~**Is Bun's WebP encoder competitive with Sharp's at equal quality?**~~ **Answered
   2026-08-28:** yes — +1.9% mean bytes at matched SSIM. Parity.
2. **Is the worker pool size configurable or observable?** Still open, and now Phase 3's
   problem. If not, our `transforms` limit and Bun's internal pool can fight, and the right
   default may be lower than CPU count. Both engines plateaued near core count on the Phase 0
   host, so `max(2, cpus)` stands.
3. ~~**Does `.jpeg()` on an alpha source flatten, reject, or produce garbage?**~~ **Answered:**
   none of those — it drops the alpha channel and keeps the RGB underneath, which is arbitrary
   and therefore unpredictable. Alpha sources fall back to PNG.
4. **Is `placeholder()` stable across Bun versions?** Open across versions, but it is
   deterministic *within* one (identical output across repeated calls), so it is safe to cache
   and safe to fold into an ETag. `bunVersion` is in the key, so a change is cache churn, not
   corruption.
5. ~~**Should AVIF be attempted at all in v0.1?**~~ **Answered:** no. Probe and expose it,
   do not list it as a feature. And it does not decode on Linux either, so AVIF is not an
   acceptable input format there — input is capability-gated like output.
6. **New — can the JPEG byte penalty be closed with encoder options?** Sharp defaults
   `optimiseCoding: true` (optimized Huffman tables); Bun exposes only `quality` and
   `progressive`. Worth asking upstream whether Huffman optimization is already on.
7. **How does arm64 behave?** Only linux/amd64 was measured. arm64 is a common deployment
   target and needs real hardware, not emulation, to time meaningfully.
8. **Does musl change anything?** Only Debian glibc 2.41 was tested.

---

## 12. Naming

Repo and meta-package: **`bun-img`**. Scope: `@bun-img/*`. Check npm availability for both
before Phase 1 — the meta-package name is the one users type, and it is worth changing the plan
over if it is taken.
