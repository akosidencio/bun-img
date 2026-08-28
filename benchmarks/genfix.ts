import sharp from "sharp";
const W = 2, H = 2;
const raw = Buffer.from([255,0,0, 0,255,0, 0,0,255, 255,255,0]); // 2x2 RGB
const base = () => sharp(raw, { raw: { width: W, height: H, channels: 3 } });

const out: Record<string, string> = {};
async function add(name: string, buf: Buffer) {
  out[name] = buf.toString("base64");
  console.log(`${name.padEnd(6)} ${String(buf.byteLength).padStart(5)} bytes  ${buf.toString("base64").length} b64 chars`);
}
await add("gif",  await base().gif().toBuffer());
await add("tiff", await base().tiff({ compression: "deflate" }).toBuffer());
try { await add("avif", await base().avif({ quality: 30, effort: 0 }).toBuffer()); }
catch (e: any) { console.log("avif encode failed:", e.message.slice(0,60)); }
await add("bmp_via_none", Buffer.alloc(0));
delete (out as any).bmp_via_none;

// HEIC: only Bun on macOS can make one
try {
  const png = await base().png().toBuffer();
  const heic = await new Bun.Image(png).heic({ quality: 30 }).bytes();
  await add("heic", Buffer.from(heic));
} catch (e: any) { console.log("heic encode failed:", e.code ?? e.message); }

await Bun.write("/tmp/probe-fixtures.json", JSON.stringify(out, null, 2));
console.log("\nwrote /tmp/probe-fixtures.json");
