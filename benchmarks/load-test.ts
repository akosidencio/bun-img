/**
 * Spec P0: "no catastrophic memory growth under sustained concurrency."
 *
 * Drives the real HTTP endpoint in a separate process and samples *that*
 * process's RSS, so the driver's own allocations never contaminate the number.
 *
 * The workload deliberately mixes both paths. An all-hits test would prove
 * nothing about the transform pipeline; an all-miss test is not what a
 * CDN-fronted endpoint actually sees. The default is 90% hot set / 10% cold,
 * which exercises the cache, the coalescer and the transform semaphore at once.
 *
 *   bun load-test.ts [--vus 200] [--seconds 300] [--port 3999]
 *
 * The verdict is gated on *validity* before it is gated on memory. A run whose
 * throughput collapses or whose error rate spikes has stopped exercising the
 * server, and flat memory in that state proves nothing — it is the memory
 * profile of an idle process. Reporting it as a pass would be worse than
 * reporting nothing.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const arg = (name: string, fallback: number) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : Number(process.argv[index + 1]);
};

const VUS = arg("vus", 200);
const SECONDS = arg("seconds", 300);
const PORT = arg("port", 3999);
const SAMPLE_MS = 2_000;

/**
 * Without a per-request deadline a stuck connection wedges its virtual user for
 * the rest of the run. Bun's `fetch` has no default timeout, so the first
 * exhausted socket silently removes a VU from the test — and enough of those
 * turn a load test into an idle process with excellent memory characteristics.
 */
const REQUEST_TIMEOUT_MS = 10_000;

const serverPath = new URL("../examples/bun-server/server.ts", import.meta.url).pathname;

// A wide allowed-width list so cold requests are genuine misses rather than
// quantizing onto the hot set.
const HOT = [320, 640, 1024];
const COLD = Array.from({ length: 200 }, (_, i) => 200 + i * 7);

const child = spawn("bun", [serverPath], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});

/**
 * Drain the child's output continuously.
 *
 * This is not tidiness — it is the difference between a load test and a
 * deadlock. A piped stdout nobody reads fills its ~64 KB buffer, and the next
 * `write` from the server blocks *forever*. A server that logs per request
 * therefore freezes a few thousand requests in, and every virtual user hangs
 * with it. The first two runs of this script did exactly that and looked like
 * socket exhaustion.
 */
const tail: string[] = [];
for (const stream of [child.stdout, child.stderr]) {
  stream?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    tail.push(text);
    if (tail.length > 20) tail.shift();
  });
}

/**
 * RSS without `ps`, which slim container images do not ship.
 *
 * `/proc/<pid>/status` is authoritative on Linux; `ps` is the fallback for
 * macOS, which has no procfs.
 */
const rssOf = async (pid: number): Promise<number> => {
  // procfs entries report size 0, so `Bun.file().exists()` says false and
  // `.text()` can come back empty — the file has to be read outright rather
  // than probed first.
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
    if (match) return Number(match[1]) * 1024;
  } catch {
    /* not Linux, or the process is gone */
  }

  // macOS has no procfs; slim container images have no `ps`. Between them the
  // two cover every host this runs on.
  try {
    const proc = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    const value = Number(text);
    return Number.isFinite(value) && value > 0 ? value * 1024 : 0;
  } catch {
    return 0;
  }
};

async function waitForReady(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://localhost:${PORT}/_image/w_320/hero.png`);
      if (response.ok) {
        await response.arrayBuffer();
        return;
      }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(200);
  }
  throw new Error("server did not become ready");
}

await waitForReady();
console.log(`server pid ${child.pid} ready on :${PORT}`);
console.log(`${VUS} virtual users, ${SECONDS}s, sampling RSS every ${SAMPLE_MS / 1000}s\n`);

let requests = 0;
let failures = 0;
let bytes = 0;
const statuses = new Map<number, number>();
let stop = false;

async function virtualUser(): Promise<void> {
  while (!stop) {
    const cold = Math.random() < 0.1;
    const width = cold
      ? COLD[Math.floor(Math.random() * COLD.length)]!
      : HOT[Math.floor(Math.random() * HOT.length)]!;

    try {
      const response = await fetch(`http://localhost:${PORT}/_image/w_${width},f_webp/hero.png`, {
        headers: { accept: "image/webp,image/*" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
      bytes += (await response.arrayBuffer()).byteLength;
      requests++;
    } catch {
      failures++;
      statuses.set(0, (statuses.get(0) ?? 0) + 1);
      // Back off briefly so a hard failure mode does not become a busy loop
      // that buries the real signal under millions of instant retries.
      await Bun.sleep(50);
    }
  }
}

const samples: Array<{ at: number; rssMB: number; requests: number; rate: number }> = [];
const started = Date.now();

let lastRequests = 0;
let lastAt = 0;
let rssUnavailable = false;

const sampler = setInterval(async () => {
  const rss = await rssOf(child.pid!);
  if (rss === 0) {
    // No RSS reading means no memory verdict is possible; say so rather than
    // averaging zeros into a confident-looking result.
    rssUnavailable = true;
  }
  const elapsed = (Date.now() - started) / 1000;
  // Interval rate, not cumulative: a cumulative average decays smoothly even
  // when throughput has gone to zero, which is exactly the failure it needs to
  // make visible.
  const rate = (requests - lastRequests) / Math.max(0.001, elapsed - lastAt);
  samples.push({ at: elapsed, rssMB: rss / 1048576, requests, rate });
  lastRequests = requests;
  lastAt = elapsed;

  if (samples.length % 15 === 0 || samples.length === 1) {
    console.log(
      `  ${elapsed.toFixed(0).padStart(4)}s  RSS ${(rss / 1048576).toFixed(0).padStart(4)} MB  ` +
        `${requests.toLocaleString().padStart(9)} requests  ` +
        `${rate.toFixed(0).padStart(5)} req/s  ${failures} failed`,
    );
  }
}, SAMPLE_MS);

const users = Array.from({ length: VUS }, () => virtualUser());
await Bun.sleep(SECONDS * 1000);
stop = true;
clearInterval(sampler);
await Promise.all(users);

child.kill("SIGKILL");

// ── verdict ──────────────────────────────────────────────────────────────────
const half = Math.floor(samples.length / 2);
const firstHalf = samples.slice(1, half);
const secondHalf = samples.slice(half);
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

const earlyRss = mean(firstHalf.map((s) => s.rssMB));
const lateRss = mean(secondHalf.map((s) => s.rssMB));
const peakRss = Math.max(...samples.map((s) => s.rssMB));
const drift = lateRss - earlyRss;
const elapsed = (Date.now() - started) / 1000;

const errorRate = failures / Math.max(1, requests + failures);
const lateRate = mean(secondHalf.map((s) => s.rate));
const earlyRate = mean(firstHalf.map((s) => s.rate));

console.log(`\n### Result — ${VUS} VUs, ${elapsed.toFixed(0)}s\n`);
console.log(`  requests        ${requests.toLocaleString()} (${(requests / elapsed).toFixed(0)}/s mean)`);
console.log(`  failures        ${failures.toLocaleString()} (${(errorRate * 100).toFixed(2)}%)`);
console.log(`  transferred     ${(bytes / 1048576).toFixed(0)} MB`);
console.log(`  statuses        ${[...statuses].map(([s, n]) => `${s}:${n}`).join(" ")}`);
console.log(`  rate early/late ${earlyRate.toFixed(0)} / ${lateRate.toFixed(0)} req/s`);
console.log(`  RSS first half  ${earlyRss.toFixed(0)} MB`);
console.log(`  RSS second half ${lateRss.toFixed(0)} MB`);
console.log(`  RSS peak        ${peakRss.toFixed(0)} MB`);
console.log(`  drift           ${drift >= 0 ? "+" : ""}${drift.toFixed(1)} MB`);

/**
 * Validity gates, checked before the memory verdict.
 *
 * A stalled run has flat memory because it is doing nothing. Without these, that
 * reads as a pass — which is how a load test comes to certify a server it never
 * loaded.
 */
const problems: string[] = [];
if (errorRate > 0.02) problems.push(`error rate ${(errorRate * 100).toFixed(1)}% exceeds 2%`);
if (lateRate < earlyRate * 0.25) {
  problems.push(
    `throughput collapsed: ${earlyRate.toFixed(0)} -> ${lateRate.toFixed(0)} req/s`,
  );
}
if (requests < VUS * 10) problems.push(`only ${requests} requests for ${VUS} VUs — too few to be meaningful`);
if (rssUnavailable) problems.push("could not read the server's RSS — no memory verdict is possible");

// A cache filling to its configured ceiling is growth by design, so the memory
// gate is on drift relative to the settled level rather than an absolute number.
const flat = Math.abs(drift) < Math.max(25, earlyRss * 0.15);
const valid = problems.length === 0;

if (!valid) {
  console.log(`\n  INVALID — this run does not test what it claims:`);
  for (const problem of problems) console.log(`    - ${problem}`);
  console.log(`  (memory drift was ${drift.toFixed(1)} MB, but flat memory in a stalled run proves nothing)`);
  if (tail.length > 0) {
    console.log(`\n  last server output:`);
    for (const line of tail.join("").trim().split("\n").slice(-5)) console.log(`    ${line}`);
  }
} else {
  console.log(`\n  ${flat ? "PASS" : "FAIL"} — spec P0 (no growth under sustained concurrency)`);
}

await Bun.write(
  new URL("./results-linux/load-test.json", import.meta.url).pathname,
  JSON.stringify(
    {
      vus: VUS, seconds: elapsed, requests, failures, errorRate, bytes,
      statuses: [...statuses], samples, earlyRss, lateRss, peakRss, drift,
      earlyRate, lateRate, valid, problems, flat,
    },
    null,
    2,
  ),
);

process.exit(valid && flat ? 0 : 1);
