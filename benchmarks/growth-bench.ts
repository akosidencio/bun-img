/**
 * Spec P0 — "no catastrophic memory growth under sustained concurrency".
 *
 * The mem bench showed Bun settling at a higher RSS than Sharp after load
 * (81 MB vs 55 MB), which is only a problem if it keeps climbing. This runs a
 * long sustained load and reports the RSS trajectory in windows, so a leak
 * shows as a rising floor rather than a one-off peak.
 */
import { fixture } from "./fixtures.ts";

const CONC = 8;
const TOTAL = 600;
const WINDOW = 100;

const engine = (process.argv[2] ?? "bun") as "bun" | "sharp";

const fx = await fixture("chroma-4k");
const src = await Bun.file(fx.file).bytes();

let once: () => Promise<unknown>;
if (engine === "bun") {
  once = () =>
    new Bun.Image(src, { maxPixels: 40_000_000 })
      .resize(800, undefined, { fit: "inside", withoutEnlargement: true, filter: "lanczos3" })
      .webp({ quality: 75 })
      .bytes();
} else {
  const sharp = (await import("sharp")).default;
  sharp.cache(false);
  const buf = Buffer.from(src);
  once = () => sharp(buf).resize(800, undefined, { fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
    .webp({ quality: 75 }).toBuffer();
}

await once();

const windows: Array<{ upTo: number; minMB: number; maxMB: number; endMB: number }> = [];
let done = 0;
let wMin = Infinity, wMax = 0;

const t0 = performance.now();
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (done < TOTAL) {
      const n = ++done;
      await once();
      const mb = process.memoryUsage.rss() / 1048576;
      if (mb < wMin) wMin = mb;
      if (mb > wMax) wMax = mb;
      if (n % WINDOW === 0) {
        windows.push({ upTo: n, minMB: wMin, maxMB: wMax, endMB: mb });
        wMin = Infinity; wMax = 0;
      }
    }
  }),
);
const dur = (performance.now() - t0) / 1000;

console.log(`\n### ${engine} — ${TOTAL} transforms of ${fx.width}x${fx.height} at ${CONC} in-flight (${dur.toFixed(0)}s)\n`);
console.log("after".padStart(8) + "min RSS".padStart(12) + "max RSS".padStart(12) + "end RSS".padStart(12));
for (const w of windows) {
  console.log(
    String(w.upTo).padStart(8) +
      `${w.minMB.toFixed(0)} MB`.padStart(12) +
      `${w.maxMB.toFixed(0)} MB`.padStart(12) +
      `${w.endMB.toFixed(0)} MB`.padStart(12),
  );
}

const firstFloor = windows[0].minMB;
const lastFloor = windows[windows.length - 1].minMB;
const drift = lastFloor - firstFloor;
console.log(
  `\n  RSS floor drift over ${TOTAL} transforms: ${drift >= 0 ? "+" : ""}${drift.toFixed(1)} MB ` +
    `(${firstFloor.toFixed(0)} -> ${lastFloor.toFixed(0)})  ${Math.abs(drift) < 40 ? "PASS" : "INVESTIGATE"}`,
);

await Bun.write(
  new URL(`./results/growth-${engine}.json`, import.meta.url).pathname,
  JSON.stringify({ engine, fixture: fx.id, concurrency: CONC, total: TOTAL, durationSec: dur, windows, drift }, null, 2),
);
