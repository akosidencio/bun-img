import { withBunImage } from "bun-img/next";

export default withBunImage({
  // This example lives inside a larger repository, so Next's workspace-root
  // inference picks the wrong directory without this.
  outputFileTracingRoot: import.meta.dirname,

  images: {
    // next/image requests exactly these widths; the endpoint is configured from
    // the same lists so nothing gets quantized up.
    deviceSizes: [640, 828, 1080, 1920],
    imageSizes: [64, 128, 256],
    qualities: [60, 75, 90],
  },
});
