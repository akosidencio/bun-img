/**
 * Isolated worker for the memory + cold-start measurements.
 *
 * Runs in its own process so RSS reflects one engine only, and so cold start is
 * genuinely cold (no shared module or codec state).
 *
 *   bun mem-worker.ts <bun|sharp> <fixturePath> <concurrency> <iterations>
 *
 * Emits one JSON line on stdout.
 */
const [engine, fixture, concArg, iterArg] = process.argv.slice(2);
const CONC = Number(concArg);
const ITERS = Number(iterArg);
const WIDTH = 800;

const processStart = performance.now();
const src = await Bun.file(fixture).bytes();

let once: () => Promise<unknown>;

if (engine === "bun") {
  once = () =>
    new Bun.Image(src, { maxPixels: 40_000_000 })
      .resize(WIDTH, undefined, { fit: "inside", withoutEnlargement: true, filter: "lanczos3" })
      .webp({ quality: 75 })
      .bytes();
} else {
  const sharp = (await import("sharp")).default;
  sharp.cache(false);
  const buf = Buffer.from(src);
  once = () =>
    sharp(buf)
      .resize(WIDTH, undefined, { fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
      .webp({ quality: 75 })
      .toBuffer();
}

// ── cold start: process launch -> first completed transform ──────────────────
await once();
const coldMs = performance.now() - processStart;

// ── sustained load, sampling RSS ────────────────────────────────────────────
const baselineRss = process.memoryUsage.rss();
let peakRss = baselineRss;
const sampler = setInterval(() => {
  const rss = process.memoryUsage.rss();
  if (rss > peakRss) peakRss = rss;
}, 5);

let done = 0;
const t0 = performance.now();
await Promise.all(
  Array.from({ length: CONC }, async () => {
    while (done < ITERS) {
      done++;
      await once();
      const rss = process.memoryUsage.rss();
      if (rss > peakRss) peakRss = rss;
    }
  }),
);
const durationMs = performance.now() - t0;
clearInterval(sampler);

const settledRss = process.memoryUsage.rss();

console.log(JSON.stringify({
  engine,
  coldMs,
  baselineRssMB: baselineRss / 1048576,
  peakRssMB: peakRss / 1048576,
  settledRssMB: settledRss / 1048576,
  opsPerSec: (ITERS / durationMs) * 1000,
}));
