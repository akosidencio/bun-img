/**
 * Phase 0 fixture preparation.
 *
 * Builds a deterministic fixture set from real photographic sources, plus the
 * synthetic cases the kill gate needs (alpha PNG, large PNG).
 *
 * Sharp is used here purely as a neutral *instrument* — it produces the
 * fixtures and, later, decodes both encoders' output to raw pixels for the
 * quality comparison. It is never on the measured path for Bun.Image results.
 */
import sharp from "sharp";
import { mkdir } from "node:fs/promises";

const OUT = new URL("./fixtures/", import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

const SRC = "/Library/Desktop Pictures";

/** name -> [source file, character] */
const PHOTO_SOURCES: Array<[string, string, string]> = [
  ["landscape", `${SRC}/Mojave Day.jpg`, "sky gradient + rock detail"],
  ["detail", `${SRC}/Flower 3.jpg`, "high-frequency botanical detail"],
  ["gradient", `${SRC}/Abstract Shapes.jpg`, "smooth synthetic gradients"],
  ["chroma", `${SRC}/Chroma 2.jpg`, "saturated, noisy"],
];

// Target the three JPEG size buckets the spec's §37 fixture table asks for by
// re-encoding the 5K sources at controlled dimensions/quality.
const BUCKETS: Array<[string, number, number]> = [
  ["1080p", 1920, 88],
  ["4k", 3840, 90],
];

const manifest: any[] = [];

for (const [name, file, character] of PHOTO_SOURCES) {
  for (const [bucket, width, quality] of BUCKETS) {
    const dest = `${OUT}${name}-${bucket}.jpg`;
    const info = await sharp(file)
      .resize(width, undefined, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: false })
      .toFile(dest);
    manifest.push({
      id: `${name}-${bucket}`, name: `${name}-${bucket}.jpg`, file: dest, kind: "jpeg", character,
      width: info.width, height: info.height, bytes: info.size,
    });
    console.log(`jpeg  ${name}-${bucket}  ${info.width}x${info.height}  ${(info.size / 1024).toFixed(0)} KB`);
  }
}

// Large PNG (lossless, photographic) — the worst case for decode cost.
{
  const dest = `${OUT}photo-large.png`;
  const info = await sharp(`${SRC}/Flower 3.jpg`)
    .resize(2560, undefined, { fit: "inside" })
    .png({ compressionLevel: 6 })
    .toFile(dest);
  manifest.push({ id: "photo-large", name: "photo-large.png", file: dest, kind: "png", character: "lossless photographic",
    width: info.width, height: info.height, bytes: info.size });
  console.log(`png   photo-large  ${info.width}x${info.height}  ${(info.size / 1024 / 1024).toFixed(1)} MB`);
}

// PNG WITH ALPHA — Phase 0 question 4. A radial soft-edged mask over a photo,
// so any flattening behaviour (black / white / garbage) is immediately visible.
{
  const W = 1200, H = 800;
  const photo = await sharp(`${SRC}/Mojave Day.jpg`)
    .resize(W, H, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer();

  const rgba = Buffer.alloc(W * H * 4);
  const cx = W / 2, cy = H / 2, maxR = Math.min(W, H) / 2;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      rgba[i * 4 + 0] = photo[i * 3 + 0];
      rgba[i * 4 + 1] = photo[i * 3 + 1];
      rgba[i * 4 + 2] = photo[i * 3 + 2];
      const d = Math.hypot(x - cx, y - cy) / maxR;
      // fully opaque in the middle, fully transparent past the radius
      rgba[i * 4 + 3] = Math.max(0, Math.min(255, Math.round(255 * (1.15 - d * 1.3))));
    }
  }

  const dest = `${OUT}alpha-radial.png`;
  const info = await sharp(rgba, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toFile(dest);
  manifest.push({ id: "alpha-radial", name: "alpha-radial.png", file: dest, kind: "png-alpha", character: "soft radial alpha over photo",
    width: info.width, height: info.height, bytes: info.size });
  console.log(`png   alpha-radial  ${W}x${H}  ${(info.size / 1024).toFixed(0)} KB  (alpha)`);
}

await Bun.write(`${OUT}manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.length} fixtures -> ${OUT}manifest.json`);
