/**
 * Backend comparison — a proxy for Linux without Docker.
 *
 * `backend: "system"` uses Accelerate/vImage geometry on macOS. `backend: "bun"`
 * uses the Highway kernels and static codecs, and Bun's docs describe that path
 * as byte-identical to a Linux build. So measuring "bun" here estimates the
 * Linux geometry path on the same silicon, and answers the question the macOS
 * throughput numbers cannot: is the win Accelerate-specific?
 *
 * It also checks that switching backend actually changes output bytes, which is
 * the premise behind including `backend` in the cache key (finding R10).
 */
import { ssim } from "./ssim.ts";
import sharp from "sharp";
import { loadFixtures } from "./fixtures.ts";

const WIDTH = 800;
const CONCURRENCIES = [1, 4, 8];
const ITERS = 24;

const manifest = await loadFixtures();
const cases = ["landscape-1080p", "chroma-4k"];

const report: any = { bunVersion: Bun.version, platform: `${process.platform}/${process.arch}`, cases: {} };

for (const id of cases) {
  const fx = manifest.find((f) => f.id === id)!;
  const src = await Bun.file(fx.file).bytes();

  const once = () =>
    new Bun.Image(src, { maxPixels: 40_000_000 })
      .resize(WIDTH, undefined, { fit: "inside", withoutEnlargement: true, filter: "lanczos3" })
      .webp({ quality: 75 })
      .bytes();

  console.log(`\n### ${id}  (${fx.width}x${fx.height})\n`);
  console.log("conc".padStart(5) + "system ops/s".padStart(15) + "bun ops/s".padStart(13) + "ratio".padStart(9));

  const rows: any[] = [];
  for (const conc of CONCURRENCIES) {
    const run = async () => {
      let done = 0;
      const t0 = performance.now();
      await Promise.all(
        Array.from({ length: conc }, async () => {
          while (done < ITERS) { done++; await once(); }
        }),
      );
      return (ITERS / (performance.now() - t0)) * 1000;
    };

    Bun.Image.backend = "system";
    await once();
    const sysOps = await run();

    Bun.Image.backend = "bun";
    await once();
    const bunOps = await run();

    Bun.Image.backend = "system";

    console.log(
      String(conc).padStart(5) + sysOps.toFixed(1).padStart(15) +
        bunOps.toFixed(1).padStart(13) + `${(bunOps / sysOps).toFixed(2)}x`.padStart(9),
    );
    rows.push({ concurrency: conc, systemOps: sysOps, bunOps, ratio: bunOps / sysOps });
  }

  // ── do the two backends actually produce different bytes? (premise of R10) ──
  Bun.Image.backend = "system";
  const sysOut = await once();
  Bun.Image.backend = "bun";
  const bunOut = await once();
  Bun.Image.backend = "system";

  const identical = sysOut.byteLength === bunOut.byteLength &&
    sysOut.every((b, i) => b === bunOut[i]);

  // and how different do they LOOK?
  const toLuma = async (b: Uint8Array) => {
    const { data, info } = await sharp(Buffer.from(b)).greyscale().raw().toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
  };
  const la = await toLuma(sysOut);
  const lb = await toLuma(bunOut);
  const visual = la.w === lb.w && la.h === lb.h ? ssim(la.data, lb.data, la.w, la.h) : NaN;

  console.log(
    `\n  bytes identical across backends: ${identical}` +
      `  (system ${sysOut.byteLength} B, bun ${bunOut.byteLength} B)`,
  );
  console.log(`  visual agreement between backends: SSIM ${visual.toFixed(5)}`);

  report.cases[id] = { rows, identical, systemBytes: sysOut.byteLength, bunBytes: bunOut.byteLength, backendSSIM: visual };
}

await Bun.write(
  new URL("./results/backend.json", import.meta.url).pathname,
  JSON.stringify(report, null, 2),
);
console.log("\n-> results/backend.json");
