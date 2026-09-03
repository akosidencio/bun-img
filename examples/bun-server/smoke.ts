/**
 * End-to-end check of the example endpoint, against the real internet.
 *
 *   bun examples/bun-server/smoke.ts
 *
 * This is deliberately *not* part of `bun test`. It talks to live third-party
 * origins, so it belongs where a flaky network fails a human's command rather
 * than the suite. The unit tests cover the same logic against a stubbed origin;
 * this exists to catch the things a stub cannot — a CDN that stops answering
 * `HEAD`, a redirect that moves, an allowlist that no longer matches reality.
 *
 * It drives the exported server from `server.ts`, so it tests the configuration
 * the example actually ships rather than a copy of it.
 */
import { createImageServer } from "bun-img/server";
import { imageUrl, srcset } from "bun-img";
import { PICSUM, UNSPLASH, images } from "./server.ts";

let failures = 0;

function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function get(path: string): Promise<Response> {
  return await images.handle(
    new Request(`http://localhost${path}`, { headers: { accept: "image/webp,image/*" } }),
  );
}

console.log("\nlocal source");
{
  const res = await get(imageUrl("/hero.png", { width: 640 }));
  check("serves a local file", res.status === 200, `${res.status} ${res.headers.get("content-type")}`);
  check("resizes it", res.headers.get("x-image-width") === "640");
}

console.log("\nremote source — the builders emit a URL that survives");
{
  // The bug this guards: the operation-path form collapses `//` to `/`, so a
  // remote source built this way used to come back as `https:/host/…` and 403.
  const built = imageUrl(UNSPLASH, { width: 640 });
  check("imageUrl switches to the query form", built.includes("?url="), built.slice(0, 48));

  const res = await get(built);
  check("fetches and transforms it", res.status === 200, `${res.status} ${res.headers.get("content-type")}`);
  check("re-encodes to a modern format", res.headers.get("content-type") === "image/webp");

  const set = srcset(UNSPLASH, { widths: [320, 640] });
  const candidates = set.srcset.split(", ").map((entry) => entry.split(" ")[0]!);
  const all = await Promise.all(candidates.map(get));
  check("every srcset candidate resolves", all.every((r) => r.status === 200),
    all.map((r) => r.status).join(" "));
}

console.log("\nremote source — a warm cache costs no download");
{
  // Unsplash answers HEAD with a Last-Modified, which is what lets identity be
  // established without opening the source.
  const url = imageUrl(UNSPLASH, { width: 1024 });
  await get(url);
  const second = await get(url);
  check("second request is a cache hit", second.headers.get("x-image-cache") === "HIT",
    second.headers.get("x-image-cache") ?? "none");
}

console.log("\nremote source — redirect, and an origin with no validator");
{
  // picsum 302s to fastly.picsum.photos, which sends neither ETag nor
  // Last-Modified. Identity cannot be established up front, so this must still
  // work by falling back to the slow path rather than failing.
  const res = await get(imageUrl(PICSUM, { width: 640 }));
  check("follows the redirect and transforms", res.status === 200,
    `${res.status} ${res.headers.get("content-type")}`);
}

console.log("\nthe allowlist actually holds");
{
  const offlist = createImageServer({
    remote: { patterns: [{ protocol: "https", hostname: "images.unsplash.com" }] },
  });
  const ask = (src: string) =>
    offlist.handle(new Request(`http://localhost${imageUrl(src, { width: 320 })}`));

  const stranger = await ask("https://example.com/a.png");
  check("refuses a host that is not listed", stranger.status === 403, String(stranger.status));

  // Every redirect hop is revalidated, so an allowlisted host cannot launder a
  // request to one that is not. This is the check that stops an allowlisted
  // origin from 302'ing into the cloud metadata service.
  const laundered = await ask(PICSUM);
  check("refuses a redirect to an unlisted host", laundered.status === 403, String(laundered.status));

  const noPatterns = createImageServer({ remote: { patterns: [] } });
  const off = await noPatterns.handle(
    new Request(`http://localhost${imageUrl(UNSPLASH, { width: 320 })}`),
  );
  check("an empty pattern list means off", off.status === 403, String(off.status));
}

console.log(
  failures === 0 ? "\nall checks passed\n" : `\n${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
