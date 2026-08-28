/**
 * Runtime guard.
 *
 * Core is Bun-only and does not pretend otherwise. This runs when an engine is
 * constructed rather than at import time, so the URL builder and `srcset` stay
 * importable in a browser bundle — adapters generate markup on the client while
 * every pixel operation stays on the server.
 */

export function assertBunImage(): void {
  if (typeof Bun === "undefined" || typeof Bun.Image !== "function") {
    throw new Error(
      "@bun-img/core requires Bun >= 1.4 with Bun.Image. " +
        "Node.js is not supported. URL building (`@bun-img/core/url`) works anywhere; " +
        "image processing does not.",
    );
  }
}
