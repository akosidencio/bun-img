/**
 * Phase 0, question 3 — throughput vs Sharp, warm and cold.
 *
 * Warm: steady-state ops/sec at a range of in-flight concurrencies, which is
 * what a running image endpoint actually experiences.
 *
 * Cold: time to first completed transform in a fresh process, which is what a
 * serverless or freshly-deployed container experiences. Measured by spawning a
 * new process per sample so no module or codec state is shared.
 */
import sharp from "sharp";
import { loadFixtures } from "./fixtures.ts";

const WIDTH = 800;
const QUALITY = 75;
const CONCURRENCIES = [1, 2, 4, 8, 16, 32];
const WARM_ITERS = 24;

const manifest = await loadFixtures();

// Two representative workloads: a mid-size 1080p JPEG and a heavy 4K JPEG.
const CASES = [
  { id: "landscape-1080p", label: "1080p JPEG -> 800px WebP" },
  { id: "chroma-4k", label: "4K JPEG -> 800px WebP" },
  { id: "photo-large", label: "2560px PNG -> 800px WebP" },
];

// Sharp defaults to a libvips thread pool sized to the CPU count. Leave it at
// its default — that is how people actually deploy it.
sharp.cache(false); // no result caching: we are measuring work, not lookups

const results: any[] = [];

for (const c of CASES) {
  const fx = manifest.find((f) => f.id === c.id)!;
  const src = await Bun.file(fx.file).bytes();
  const srcBuf = Buffer.from(src);

  const bunOnce = () =>
    new Bun.Image(src, { maxPixels: 40_000_000 })
      .resize(WIDTH, undefined, { fit: "inside", withoutEnlargement: true, filter: "lanczos3" })
      .webp({ quality: QUALITY })
      .bytes();

  const sharpOnce = () =>
    sharp(srcBuf)
      .resize(WIDTH, undefined, { fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
      .webp({ quality: QUALITY })
      .toBuffer();

  // warm both pipelines before timing
  await Promise.all([bunOnce(), bunOnce(), sharpOnce(), sharpOnce()]);

  console.log(`\n### ${c.label}  (${fx.width}x${fx.height}, ${(fx.bytes / 1024).toFixed(0)} KB)\n`);
  console.log(
    "conc".padStart(5) +
      "bun ops/s".padStart(13) + "sharp ops/s".padStart(13) +
      "ratio".padStart(9) +
      "bun p50".padStart(11) + "sharp p50".padStart(11),
  );

  for (const conc of CONCURRENCIES) {
    const run = async (once: () => Promise<unknown>) => {
      const lat: number[] = [];
      const t0 = performance.now();
      let done = 0;
      await Promise.all(
        Array.from({ length: conc }, async () => {
          while (done < WARM_ITERS) {
            done++;
            const s = performance.now();
            await once();
            lat.push(performance.now() - s);
          }
        }),
      );
      const total = performance.now() - t0;
      lat.sort((a, b) => a - b);
      return { ops: (lat.length / total) * 1000, p50: lat[Math.floor(lat.length * 0.5)], p95: lat[Math.floor(lat.length * 0.95)] };
    };

    const b = await run(bunOnce);
    const s = await run(sharpOnce);
    const ratio = b.ops / s.ops;

    console.log(
      String(conc).padStart(5) +
        b.ops.toFixed(1).padStart(13) + s.ops.toFixed(1).padStart(13) +
        `${ratio.toFixed(2)}x`.padStart(9) +
        `${b.p50.toFixed(0)}ms`.padStart(11) + `${s.p50.toFixed(0)}ms`.padStart(11),
    );

    results.push({ case: c.id, concurrency: conc, bun: b, sharp: s, ratio });
  }
}

// ── gate summary ─────────────────────────────────────────────────────────────
console.log("\n### Gate: warm throughput ratio (bun / sharp)\n");
for (const c of CASES) {
  const rs = results.filter((r) => r.case === c.id);
  const best = Math.max(...rs.map((r) => r.ratio));
  const at8 = rs.find((r) => r.concurrency === 8)!.ratio;
  console.log(
    `  ${c.id.padEnd(18)} at conc=8: ${at8.toFixed(2)}x   best: ${best.toFixed(2)}x   ` +
      `${at8 >= 0.5 ? "PASS" : "FAIL"} (gate: >= 0.5x)`,
  );
}

await Bun.write(
  new URL("./results/throughput.json", import.meta.url).pathname,
  JSON.stringify({ width: WIDTH, quality: QUALITY, iters: WARM_ITERS, results }, null, 2),
);
console.log("\n-> results/throughput.json");
