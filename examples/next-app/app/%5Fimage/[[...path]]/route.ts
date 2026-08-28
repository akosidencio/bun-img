/**
 * The bun-img endpoint, mounted inside a Next App Router app.
 *
 * The folder is named `%5Fimage`, not `_image`.
 *
 * App Router treats a leading underscore as a *private folder* and excludes it
 * from routing entirely — so `app/_image/…/route.ts` silently never resolves,
 * and every `next/image` request 404s with nothing to explain why. `%5F` is the
 * URL-encoded underscore, which Next maps back to a literal `_` in the route.
 */
import { createNextImageRoute } from "bun-img/next";
import { join } from "node:path";

const { GET, HEAD } = createNextImageRoute({
  path: "/_image",
  local: { root: join(process.cwd(), "public") },
  cache: {
    memory: { maxSize: "128MB" },
    disk: { directory: join(process.cwd(), ".cache/images"), maxSize: "1GB" },
  },
  nextImages: {
    deviceSizes: [640, 828, 1080, 1920],
    imageSizes: [64, 128, 256],
    qualities: [60, 75, 90],
  },
});

export { GET, HEAD };
