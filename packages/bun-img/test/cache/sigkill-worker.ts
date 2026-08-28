/**
 * Writes cache entries in a loop and never exits.
 *
 * The parent SIGKILLs it mid-write. Whatever the filesystem holds afterwards is
 * what a real crash leaves behind, which is the only honest way to test the
 * claim that an entry is either complete or absent.
 *
 *   bun sigkill-worker.ts <directory>
 */
import { diskCache } from "../../src/cache/disk.ts";

const directory = process.argv[2]!;
const cache = diskCache({ directory });

// Large enough that a write spans multiple syscalls, so a kill has a real
// chance of landing in the middle of one.
const payload = new Uint8Array(2 * 1024 * 1024).fill(0xab);

console.log("ready");

for (let i = 0; ; i++) {
  await cache.set(`bimg_${i.toString(16).padStart(8, "0")}`, {
    bytes: payload,
    width: 1000,
    height: 500,
    format: "webp",
    etag: `"bimg_${i}"`,
    storedAt: Date.now(),
  });
}
