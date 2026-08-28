/**
 * The crash-safety criterion, tested with a real crash.
 *
 * Phase 3's acceptance condition is that the disk cache "survives SIGKILL
 * mid-write with no corrupt entries". Simulating that by writing a truncated
 * file only tests the reader; sending an actual SIGKILL to a process that is
 * genuinely mid-write tests the writer, which is where the guarantee lives.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { diskCache } from "../../src/cache/disk.ts";

let scratch: string;

beforeAll(() => {
  scratch = join(tmpdir(), `bun-img-sigkill-${Bun.randomUUIDv7()}`);
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("SIGKILL during writes", () => {
  test("leaves every surviving entry complete and readable", async () => {
    const directory = join(scratch, "killed");
    const worker = new URL("./sigkill-worker.ts", import.meta.url).pathname;

    const proc = Bun.spawn(["bun", worker, directory], { stdout: "pipe", stderr: "pipe" });

    // Let it get into a steady rhythm of large writes, then kill it without
    // warning — no flush, no cleanup, no chance to finish the file in flight.
    await Bun.sleep(700);
    proc.kill("SIGKILL");
    await proc.exited;

    // Reopen exactly as a restarted server would.
    const cache = diskCache({ directory });
    const size = await cache.size();

    // The run should have produced *something*, or the test proves nothing.
    expect(size.entries).toBeGreaterThan(0);

    // Every entry the index admits must decode cleanly and completely. A
    // half-written file would either fail to decode or come back short.
    let verified = 0;
    for (let i = 0; i < size.entries + 5; i++) {
      const key = `bimg_${i.toString(16).padStart(8, "0")}`;
      const hit = await cache.get(key);
      if (!hit) continue;
      expect(hit.bytes.byteLength).toBe(2 * 1024 * 1024);
      expect(hit.width).toBe(1000);
      expect(hit.format).toBe("webp");
      // Spot-check the payload rather than every byte of many megabytes.
      expect(hit.bytes[0]).toBe(0xab);
      expect(hit.bytes[hit.bytes.byteLength - 1]).toBe(0xab);
      verified++;
    }
    expect(verified).toBeGreaterThan(0);

    // Temp files from the interrupted write are swept, not counted, not served.
    const leftovers: string[] = [];
    for await (const relative of new Bun.Glob("**/*").scan({
      cwd: directory,
      onlyFiles: true,
      dot: true,
    })) {
      if (relative.startsWith(".tmp/")) leftovers.push(relative);
    }
    expect(leftovers).toEqual([]);
  }, 60_000);
});
