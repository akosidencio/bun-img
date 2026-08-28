# bun-img × Next.js

Point `next/image` at a bun-img endpoint. Application code does not change —
only the transformation backend moves.

```tsx
import Image from "next/image";

<Image src="/hero.png" width={1920} height={1080} alt="Hero" />
```

## Setup

**1. `next.config.ts`**

```ts
import { withBunImage } from "bun-img/next";

export default withBunImage({
  images: {
    deviceSizes: [640, 828, 1080, 1920],
    imageSizes: [64, 128, 256],
    qualities: [60, 75, 90],
  },
});
```

**2. `image-loader.ts`** — Next requires `loaderFile` to name a file with a
default export, and bundles it for the browser:

```ts
export { default } from "bun-img/next/loader";
```

**3. The endpoint** — `app/%5Fimage/[[...path]]/route.ts`:

```ts
import { createNextImageRoute } from "bun-img/next";
import { join } from "node:path";

export const { GET, HEAD } = createNextImageRoute({
  local: { root: join(process.cwd(), "public") },
  cache: { memory: { maxSize: "128MB" } },
  nextImages: { deviceSizes: [640, 828, 1080, 1920], imageSizes: [64, 128, 256] },
});
```

## Four things that will bite you

**The folder is `%5Fimage`, not `_image`.** App Router treats a leading
underscore as a *private folder* and excludes it from routing, so
`app/_image/…/route.ts` never resolves and every image 404s with nothing to
explain why. `%5F` is the URL-encoded underscore, which Next maps back to a
literal `_`.

**Run the server under Bun.** `bun --bun next start` (and `bun --bun next dev`).
The engine needs `Bun.Image`. `next build` is fine under Node — the engine is
constructed lazily on the first request precisely so the build's Node worker
never touches it.

**Pass `nextImages` so the widths line up.** `next/image` requests exactly the
widths in `deviceSizes` and `imageSizes`; the endpoint quantizes to its own list.
If they disagree, every width snaps up to the next allowed one — the response is
*larger* than the markup declares, the browser scales it down, and each logical
width takes two cache entries. Nothing errors. Passing `nextImages` derives one
list from the other, and a mismatch is reported at startup.

**Next still declares Sharp.** `next` lists `sharp` in its own
`optionalDependencies`, so it may land in your store (~21 MB) even though
`loader: "custom"` means Next never loads it. To remove it too, exclude optional
dependencies at install time. bun-img itself pulls in nothing native.

## Why the loader emits `f_auto`

Next's loader is client-side and receives only `{ src, width, quality }` — it
cannot see the `Accept` header. Format selection therefore happens on the server,
at the endpoint, which is what `f_auto` asks for. A loader that picked a format
would be guessing, and would ship the same one to every client.

## Remote images

```ts
withBunImage({
  images: { remotePatterns: [{ protocol: "https", hostname: "cdn.example.com" }] },
});
```

Patterns are translated into the engine's allowlist, so `next/image` and the
endpoint agree on which hosts are permitted. Remote sources stay disabled until
at least one pattern exists — there is no wildcard.

## Requirements

Bun >= 1.4 with `Bun.Image`, and Next 15+ with the App Router. This package never
imports `next`; it only translates its config shape, which a test enforces.
