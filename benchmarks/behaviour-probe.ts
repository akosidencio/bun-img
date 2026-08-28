/**
 * Phase 0, questions 1 and 4 — capability matrix and alpha handling.
 *
 * Question 4 matters because §6.5 of the plan routes non-encodable formats to a
 * fallback, and Bun has no flatten/background operation. If `.jpeg()` on an
 * alpha source produces garbage, the fallback rule has to change.
 */
import sharp from "sharp";
import { fixture } from "./fixtures.ts";


const alphaFx = await fixture("alpha-radial");
const alphaSrc = await Bun.file(alphaFx.file).bytes();

const report: any = { bunVersion: Bun.version, platform: `${process.platform}/${process.arch}` };

// ── Q1: encoder / decoder matrix, per backend ────────────────────────────────
const tiny = await new Bun.Image(alphaSrc).resize(16, 16, { fit: "fill" }).png().bytes();
const FORMATS = ["jpeg", "png", "webp", "heic", "avif"] as const;

console.log(`### Capability matrix — Bun ${Bun.version} on ${process.platform}/${process.arch}\n`);
console.log("format".padEnd(9) + "backend=system".padStart(18) + "backend=bun".padStart(18));

report.encode = {};
for (const f of FORMATS) {
  const row: any = {};
  for (const backend of ["system", "bun"] as const) {
    Bun.Image.backend = backend;
    try {
      const out = await (new Bun.Image(tiny) as any)[f]({}).bytes();
      row[backend] = { ok: true, bytes: out.byteLength };
    } catch (e: any) {
      row[backend] = { ok: false, code: e.code ?? e.name };
    }
  }
  report.encode[f] = row;
  const cell = (r: any) => (r.ok ? "encode" : r.code.replace("ERR_IMAGE_", "").toLowerCase());
  console.log(f.padEnd(9) + cell(row.system).padStart(18) + cell(row.bun).padStart(18));
}
Bun.Image.backend = "system";

// ── decode matrix ────────────────────────────────────────────────────────────
console.log("\n### Decode\n");
report.decode = {};
const decodeCases: Array<[string, Uint8Array]> = [];

// build one sample per decodable container using sharp where Bun cannot encode it
for (const [name, make] of [
  ["jpeg", () => sharp(Buffer.from(alphaSrc)).flatten().jpeg().toBuffer()],
  ["png", () => sharp(Buffer.from(alphaSrc)).png().toBuffer()],
  ["webp", () => sharp(Buffer.from(alphaSrc)).webp().toBuffer()],
  ["gif", () => sharp(Buffer.from(alphaSrc)).gif().toBuffer()],
  ["tiff", () => sharp(Buffer.from(alphaSrc)).tiff().toBuffer()],
  ["avif", () => sharp(Buffer.from(alphaSrc)).avif({ quality: 50 }).toBuffer()],
] as Array<[string, () => Promise<Buffer>]>) {
  try {
    decodeCases.push([name, new Uint8Array(await make())]);
  } catch (e: any) {
    console.log(`${name.padEnd(9)} (sharp could not produce a sample: ${e.message.slice(0, 40)})`);
  }
}

for (const [name, bytes] of decodeCases) {
  try {
    const md = await new Bun.Image(bytes).metadata();
    report.decode[name] = { ok: true, reported: md.format };
    console.log(`${name.padEnd(9)} decode OK   reports format="${md.format}"  ${md.width}x${md.height}`);
  } catch (e: any) {
    report.decode[name] = { ok: false, code: e.code ?? e.name };
    console.log(`${name.padEnd(9)} FAIL  ${e.code ?? e.name}`);
  }
}

// ── Q4: what happens to alpha when the target format has none? ───────────────
console.log("\n### Q4 — alpha PNG encoded to JPEG\n");

/** Average RGB of the fully-transparent corner region, after flattening onto nothing. */
async function cornerColour(buf: Uint8Array) {
  const { data } = await sharp(Buffer.from(buf))
    .extract({ left: 0, top: 0, width: 40, height: 40 })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < data.length; i += 3) { r += data[i]; g += data[i + 1]; b += data[i + 2]; }
  const n = data.length / 3;
  return [r / n, g / n, b / n].map((v) => Math.round(v));
}

const describe = (c: number[]) => {
  const [r, g, b] = c;
  if (r < 24 && g < 24 && b < 24) return "BLACK";
  if (r > 231 && g > 231 && b > 231) return "WHITE";
  return "source colour (alpha ignored)";
};

try {
  const bunJpeg = await new Bun.Image(alphaSrc).jpeg({ quality: 90 }).bytes();
  const c = await cornerColour(bunJpeg);
  report.alphaToJpeg = { bun: { ok: true, corner: c, verdict: describe(c) } };
  console.log(`  bun.jpeg()    OK   transparent corner -> rgb(${c.join(",")})  =>  ${describe(c)}`);
} catch (e: any) {
  report.alphaToJpeg = { bun: { ok: false, code: e.code ?? e.name } };
  console.log(`  bun.jpeg()    FAIL ${e.code ?? e.name}`);
}

{
  const sharpJpeg = await sharp(Buffer.from(alphaSrc)).jpeg({ quality: 90 }).toBuffer();
  const c = await cornerColour(sharpJpeg);
  report.alphaToJpeg.sharp = { ok: true, corner: c, verdict: describe(c) };
  console.log(`  sharp.jpeg()  OK   transparent corner -> rgb(${c.join(",")})  =>  ${describe(c)}`);
}

// alpha preserved through WebP?
{
  const bunWebp = await new Bun.Image(alphaSrc).webp({ quality: 80 }).bytes();
  const md = await sharp(Buffer.from(bunWebp)).metadata();
  report.alphaToWebp = { hasAlpha: md.hasAlpha, channels: md.channels };
  console.log(`\n  bun.webp()    alpha preserved: ${md.hasAlpha}  (${md.channels} channels)`);
}

// ── extra: is placeholder() output stable across calls? ──────────────────────
{
  const a = await new Bun.Image(alphaSrc).placeholder();
  const b = await new Bun.Image(alphaSrc).placeholder();
  report.placeholderDeterministic = a === b;
  report.placeholderBytes = a.length;
  console.log(`\n### placeholder()\n\n  deterministic across calls: ${a === b}   length: ${a.length} chars`);
}

await Bun.write(
  new URL("./results/behaviour.json", import.meta.url).pathname,
  JSON.stringify(report, null, 2),
);
console.log("\n-> results/behaviour.json");
