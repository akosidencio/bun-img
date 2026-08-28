/**
 * Phase 0, questions 3 (cold start) and 6 (peak RSS at 8 in-flight 4K transforms).
 *
 * Each sample is a fresh process running exactly one engine, so RSS is not
 * contaminated by the other library being loaded and cold start is real.
 */
import { fixture } from "./fixtures.ts";

const CONC = 8;
const ITERS = 40;
const SAMPLES = 3;


const fx = await fixture("chroma-4k");
const worker = new URL("./mem-worker.ts", import.meta.url).pathname;

async function sample(engine: "bun" | "sharp") {
  const proc = Bun.spawn(["bun", worker, engine, fx.file, String(CONC), String(ITERS)], {
    stdout: "pipe", stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  const line = out.trim().split("\n").filter(Boolean).pop();
  if (!line) throw new Error(`worker produced no output: ${err}`);
  return JSON.parse(line);
}

const runs: Record<string, any[]> = { bun: [], sharp: [] };
for (let i = 0; i < SAMPLES; i++) {
  for (const engine of ["bun", "sharp"] as const) {
    runs[engine].push(await sample(engine));
    process.stdout.write(".");
  }
}
console.log("\n");

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

console.log(`### ${fx.width}x${fx.height} JPEG -> 800px WebP, ${CONC} in-flight, ${ITERS} transforms, median of ${SAMPLES}\n`);
console.log(
  "engine".padEnd(9) + "cold start".padStart(13) + "baseline RSS".padStart(15) +
    "peak RSS".padStart(12) + "settled RSS".padStart(14) + "ops/s".padStart(9),
);

const stats: any = {};
for (const engine of ["bun", "sharp"] as const) {
  const r = runs[engine];
  const s = {
    coldMs: median(r.map((x) => x.coldMs)),
    baselineRssMB: median(r.map((x) => x.baselineRssMB)),
    peakRssMB: median(r.map((x) => x.peakRssMB)),
    settledRssMB: median(r.map((x) => x.settledRssMB)),
    opsPerSec: median(r.map((x) => x.opsPerSec)),
  };
  stats[engine] = s;
  console.log(
    engine.padEnd(9) +
      `${s.coldMs.toFixed(0)}ms`.padStart(13) +
      `${s.baselineRssMB.toFixed(0)} MB`.padStart(15) +
      `${s.peakRssMB.toFixed(0)} MB`.padStart(12) +
      `${s.settledRssMB.toFixed(0)} MB`.padStart(14) +
      s.opsPerSec.toFixed(1).padStart(9),
  );
}

const rssRatio = stats.bun.peakRssMB / stats.sharp.peakRssMB;
const coldRatio = stats.bun.coldMs / stats.sharp.coldMs;

console.log("\n### Gate\n");
console.log(`  peak RSS   bun / sharp = ${rssRatio.toFixed(2)}x   ${rssRatio <= 2 ? "PASS" : "FAIL"} (gate: <= 2x)`);
console.log(`  cold start bun / sharp = ${coldRatio.toFixed(2)}x   (informational)`);

await Bun.write(
  new URL("./results/memory.json", import.meta.url).pathname,
  JSON.stringify({ fixture: fx.id, concurrency: CONC, iters: ITERS, samples: SAMPLES, runs, stats, rssRatio, coldRatio }, null, 2),
);
console.log("\n-> results/memory.json");
