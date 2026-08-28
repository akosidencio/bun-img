import { defineConfig } from "astro/config";

export default defineConfig({
  image: {
    // A local image service: Astro hands `transform()` the bytes and takes the
    // bytes back. No HTTP, no Sharp, no libvips.
    service: { entrypoint: "bun-img/astro" },
  },
});
