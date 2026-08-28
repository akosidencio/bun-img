/**
 * Correction to backend-bench.ts.
 *
 * backend-bench compared the two backends' *WebP q75* outputs, so its SSIM
 * figure (0.980–0.990) folds in lossy encoding noise from both sides and
 * overstates how much the geometry actually differs.
 *
 * This isolates it: resize on each backend, emit LOSSLESS PNG, compare. Whatever
 * difference survives is purely the resize kernel (Accelerate/vImage vs Highway)
 * plus the decoder.
 *
 * The cache-key conclusion does not depend on the magnitude — differing bytes
 * alone make a shared cache wrong — but the claim about *how* different deserves
 * an honest number.
 */
import sharp from "sharp";
import { ssim, dssim } from "./ssim.ts";
import { loadFixtures } from "./fixtures.ts";

const WIDTH = 800;
const manifest = await loadFixtures();
const cases = ["landscape-1080p", "detail-1080p", "gradient-1080p", "chroma-4k"];

const toLuma = async (b: Uint8Array) => {
  const { data, info } = await sharp(Buffer.from(b)).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
};

const resizeOn = async (backend: "system" | "bun", src: Uint8Array, lossless: boolean) => {
  Bun.Image.backend = backend;
  const img = new Bun.Image(src, { maxPixels: 40_000_000 }).resize(WIDTH, undefined, {
    fit: "inside", withoutEnlargement: true, filter: "lanczos3",
  });
  return lossless ? await img.png({ compressionLevel: 1 }).bytes() : await img.webp({ quality: 75 }).bytes();
};

console.log(`### Backend geometry difference — ${process.platform}/${process.arch}\n`);
console.log(
  "fixture".padEnd(18) + "lossless SSIM".padStart(16) + "q75 SSIM".padStart(12) +
    "bytes differ".padStart(15),
);

const rows: any[] = [];
for (const id of cases) {
  const fx = manifest.find((f) => f.id === id)!;
  const src = await Bun.file(fx.file).bytes();

  const sysPng = await resizeOn("system", src, true);
  const bunPng = await resizeOn("bun", src, true);
  const sysWebp = await resizeOn("system", src, false);
  const bunWebp = await resizeOn("bun", src, false);
  Bun.Image.backend = "system";

  const [a, b] = [await toLuma(sysPng), await toLuma(bunPng)];
  const [c, d] = [await toLuma(sysWebp), await toLuma(bunWebp)];

  const losslessSSIM = ssim(a.data, b.data, a.w, a.h);
  const lossySSIM = ssim(c.data, d.data, c.w, c.h);
  const differ = sysPng.byteLength !== bunPng.byteLength ||
    !sysPng.every((x, i) => x === bunPng[i]);

  console.log(
    id.padEnd(18) + losslessSSIM.toFixed(5).padStart(16) +
      lossySSIM.toFixed(5).padStart(12) + String(differ).padStart(15),
  );
  rows.push({ fixture: id, losslessSSIM, lossyQ75SSIM: lossySSIM, bytesDiffer: differ,
              losslessDSSIM: dssim(losslessSSIM) });
}

const meanLossless = rows.reduce((s, r) => s + r.losslessSSIM, 0) / rows.length;
const meanLossy = rows.reduce((s, r) => s + r.lossyQ75SSIM, 0) / rows.length;

console.log(`\n  mean lossless SSIM (pure geometry): ${meanLossless.toFixed(5)}`);
console.log(`  mean q75 SSIM (geometry + 2x encode): ${meanLossy.toFixed(5)}`);
const anyDiffer = rows.some((r) => r.bytesDiffer);

if (anyDiffer) {
  const overstatement = dssim(meanLossless) === 0
    ? Infinity
    : dssim(meanLossy) / dssim(meanLossless);
  console.log(
    `\n  => q75 comparison overstates the geometry difference by ` +
      `${overstatement.toFixed(1)}x in DSSIM terms.`,
  );
  console.log(`  => bytes differ per fixture: the cache key must include backend.`);
} else {
  // The Linux case: `backend: "system"` has no OS codecs to fall back on, so
  // both settings take the same Highway path and emit identical bytes. The
  // backend field is inert here — it earns its place in the cache key only
  // where a store is shared with a platform that does have OS codecs.
  console.log(`\n  => both backends emit IDENTICAL bytes on this platform.`);
  console.log(`  => backend is inert in the cache key here; it matters only across platforms.`);
}

await Bun.write(
  new URL("./results/backend-geometry.json", import.meta.url).pathname,
  JSON.stringify({ platform: `${process.platform}/${process.arch}`, rows, meanLossless, meanLossy }, null, 2),
);
