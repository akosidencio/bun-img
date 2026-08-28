/**
 * Phase 0, question 2 — the kill gate.
 *
 * "At matched perceptual quality, how many bytes does Bun.Image's encoder spend
 *  compared to Sharp's?"
 *
 * Method
 * ------
 * For each fixture and each engine:
 *   1. Resize to the delivery width with that engine's own pipeline.
 *   2. Emit a LOSSLESS reference (PNG) at that size — this is the engine's own
 *      resampler output, so the comparison isolates ENCODER quality from
 *      RESAMPLER quality.
 *   3. Sweep encoder quality, measuring bytes and SSIM against that reference.
 *   4. Interpolate the bytes needed to reach fixed SSIM targets.
 *
 * Reporting bun/sharp byte ratios at matched SSIM is the honest comparison;
 * comparing bytes at matched `quality:` number would be meaningless, since the
 * two encoders' quality scales are not the same scale.
 *
 * Resampler agreement is reported separately by cross-comparing the two
 * lossless references.
 */
import sharp from "sharp";
import { ssim, dssim, bytesAtSSIM } from "./ssim.ts";
import { loadFixtures } from "./fixtures.ts";

const WIDTH = 800;
const QUALITIES = [40, 50, 60, 70, 75, 80, 85, 90, 95];
const TARGETS = [0.96, 0.98, 0.99];

const manifest = await loadFixtures();
const fixtures = manifest.filter((f) => f.kind === "jpeg");

/** Decode any encoded image to single-channel 8-bit luma at known dimensions. */
async function luma(buf: Uint8Array | Buffer) {
  const { data, info } = await sharp(Buffer.from(buf))
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
}

type Point = { quality: number; bytes: number; ssim: number };
type Row = {
  fixture: string; character: string; format: "webp" | "jpeg";
  bun: Point[]; sharp: Point[];
  resamplerSSIM: number;
};

const rows: Row[] = [];

for (const fx of fixtures) {
  const src = await Bun.file(fx.file).bytes();

  // ── lossless references, one per engine ────────────────────────────────────
  const bunRefPng = await new Bun.Image(src, { maxPixels: 40_000_000 })
    .resize(WIDTH, undefined, { fit: "inside", withoutEnlargement: true, filter: "lanczos3" })
    .png({ compressionLevel: 1 })
    .bytes();

  const sharpRefPng = await sharp(Buffer.from(src))
    .resize(WIDTH, undefined, { fit: "inside", withoutEnlargement: true, kernel: "lanczos3" })
    .png({ compressionLevel: 1 })
    .toBuffer();

  const bunRef = await luma(bunRefPng);
  const sharpRef = await luma(sharpRefPng);

  // how closely do the two resamplers agree? (separate question from encoding)
  const resamplerSSIM =
    bunRef.w === sharpRef.w && bunRef.h === sharpRef.h
      ? ssim(bunRef.data, sharpRef.data, bunRef.w, bunRef.h)
      : NaN;

  for (const format of ["webp", "jpeg"] as const) {
    const bunPts: Point[] = [];
    const sharpPts: Point[] = [];

    for (const q of QUALITIES) {
      // ── Bun.Image ──
      let img = new Bun.Image(src, { maxPixels: 40_000_000 }).resize(WIDTH, undefined, {
        fit: "inside", withoutEnlargement: true, filter: "lanczos3",
      });
      img = format === "webp" ? img.webp({ quality: q }) : img.jpeg({ quality: q });
      const bunOut = await img.bytes();
      const bunLuma = await luma(bunOut);
      bunPts.push({ quality: q, bytes: bunOut.byteLength, ssim: ssim(bunRef.data, bunLuma.data, bunRef.w, bunRef.h) });

      // ── Sharp ──
      let sh = sharp(Buffer.from(src)).resize(WIDTH, undefined, {
        fit: "inside", withoutEnlargement: true, kernel: "lanczos3",
      });
      sh = format === "webp" ? sh.webp({ quality: q }) : sh.jpeg({ quality: q });
      const sharpOut = await sh.toBuffer();
      const sharpLuma = await luma(sharpOut);
      sharpPts.push({ quality: q, bytes: sharpOut.byteLength, ssim: ssim(sharpRef.data, sharpLuma.data, sharpRef.w, sharpRef.h) });
    }

    rows.push({ fixture: fx.id, character: fx.character, format, bun: bunPts, sharp: sharpPts, resamplerSSIM });
    process.stdout.write(".");
  }
}
console.log("\n");

// ── report ───────────────────────────────────────────────────────────────────
const pct = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}%`;
const summary: any[] = [];

for (const format of ["webp", "jpeg"] as const) {
  console.log(`\n### ${format.toUpperCase()} — bytes at matched SSIM (bun vs sharp)\n`);
  console.log(
    "fixture".padEnd(18) +
      TARGETS.map((t) => `SSIM ${t}`.padStart(22)).join("") ,
  );

  for (const row of rows.filter((r) => r.format === format)) {
    let line = row.fixture.padEnd(18);
    const rec: any = { fixture: row.fixture, format, deltas: {} };
    for (const t of TARGETS) {
      const b = bytesAtSSIM(row.bun, t);
      const s = bytesAtSSIM(row.sharp, t);
      if (b == null || s == null) {
        line += "unreachable".padStart(22);
        rec.deltas[t] = null;
        continue;
      }
      const delta = b / s - 1;
      rec.deltas[t] = { bunBytes: Math.round(b), sharpBytes: Math.round(s), delta };
      line += `${(b / 1024).toFixed(0)}K vs ${(s / 1024).toFixed(0)}K ${pct(delta)}`.padStart(22);
    }
    console.log(line);
    summary.push(rec);
  }

  // aggregate: mean delta across fixtures at each target
  console.log("");
  for (const t of TARGETS) {
    const ds = summary
      .filter((r) => r.format === format && r.deltas[t])
      .map((r) => r.deltas[t].delta);
    if (!ds.length) continue;
    const mean = ds.reduce((a, b) => a + b, 0) / ds.length;
    const worst = Math.max(...ds);
    console.log(
      `  SSIM ${t}:  mean ${pct(mean).padStart(7)}   worst ${pct(worst).padStart(7)}   ` +
        `${mean <= 0.15 ? "PASS" : "FAIL"} (gate: mean <= +15%)`,
    );
  }
}

console.log("\n### Resampler agreement (bun lanczos3 vs sharp lanczos3, lossless)\n");
for (const row of rows.filter((r) => r.format === "webp")) {
  console.log(
    `  ${row.fixture.padEnd(18)} SSIM ${row.resamplerSSIM.toFixed(5)}   DSSIM ${dssim(row.resamplerSSIM).toFixed(5)}`,
  );
}

await Bun.write(
  new URL("./results/quality.json", import.meta.url).pathname,
  JSON.stringify({ width: WIDTH, qualities: QUALITIES, targets: TARGETS, rows, summary }, null, 2),
);
console.log("\n-> results/quality.json");
