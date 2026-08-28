/**
 * Runtime guard.
 *
 * Fires when an engine is *constructed*, not at import time. That distinction
 * carries real weight:
 *
 *   - `bun-img/url` and `srcset` have to stay importable in a browser bundle,
 *     which is how adapters build markup on the client.
 *   - `next build` and Astro's config load evaluate these modules under Node
 *     without ever making an engine, and both must keep working.
 *
 * So importing is always safe, and using is where the requirement bites.
 */

/** Bun without `Bun.Image` means a version older than 1.4. */
function bunVersion(): string | null {
  return typeof Bun === "undefined" ? null : (Bun.version ?? "unknown");
}

export function assertBunImage(): void {
  if (typeof Bun !== "undefined" && typeof Bun.Image === "function") return;

  const version = bunVersion();

  // Two different problems deserve two different instructions: one is "you are
  // on the wrong runtime", the other is "you are on the right one, outdated".
  const diagnosis =
    version === null
      ? [
          `bun-img requires Bun; this is ${
            typeof process !== "undefined" && process.versions?.node
              ? `Node.js ${process.versions.node}`
              : "not Bun"
          }.`,
          "",
          "  Image processing uses Bun.Image and cannot run anywhere else.",
          "  URL building works everywhere:  import { imageUrl, srcset } from \"bun-img/url\"",
          "",
          "  Running through a framework? Name the runtime explicitly:",
          "    bun --bun next start",
          "    bun --bun astro build",
        ].join("\n")
      : [
          `bun-img requires Bun >= 1.4 for Bun.Image; this is Bun ${version}.`,
          "",
          "  Upgrade with:  bun upgrade",
        ].join("\n");

  throw new Error(`${diagnosis}\n\n  https://github.com/akosidencio/bun-img\n`);
}
