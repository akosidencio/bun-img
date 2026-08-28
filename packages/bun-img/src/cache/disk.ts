/**
 * Filesystem cache.
 *
 * Two properties matter more than speed here:
 *
 * **Crash safety.** Every entry is written to a temp file and then `rename`d
 * into place. `rename` within a filesystem is atomic, so a reader sees either
 * the complete entry or no entry — never a half-written one. A `SIGKILL`
 * mid-write leaves a stray temp file, which the next startup scan sweeps.
 *
 * **A bounded size.** The index tracks bytes, and eviction runs on write, so a
 * flood of distinct widths cannot grow the directory without limit.
 *
 * One entry is one file: header and body together. A sidecar metadata file
 * would need two renames, and there is no way to make that pair atomic.
 *
 * `rename` is the only operation here with no Bun-native equivalent —
 * `Bun.write` creates parent directories, `Bun.Glob` scans, and
 * `Bun.file().delete()` unlinks.
 */
import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { CachedImage, ImageCache } from "./types.ts";
import type { ImageFormat } from "../types.ts";
import { parseSize } from "./size.ts";

export interface DiskCacheOptions {
  directory: string;
  /** `"2GB"`, or a raw byte count. */
  maxSize?: string | number;
  /** Sweep temp files and build the size index on construction. */
  eager?: boolean;
}

const MAGIC = new Uint8Array([0x42, 0x49, 0x4d, 0x47]); // "BIMG"
const FORMAT_VERSION = 1;
const HEADER_OFFSET = 4 + 1 + 4;
const TMP_DIR = ".tmp";

interface EntryHeader {
  width: number;
  height: number;
  format: ImageFormat;
  etag: string;
  storedAt: number;
  sourceVersion?: string;
  byteLength: number;
}

interface IndexEntry {
  size: number;
  storedAt: number;
  /** In-memory recency. Resets on restart, where `storedAt` takes over. */
  lastUsed: number;
}

function encodeEntry(image: CachedImage): Uint8Array {
  const header: EntryHeader = {
    width: image.width,
    height: image.height,
    format: image.format,
    etag: image.etag,
    storedAt: image.storedAt,
    byteLength: image.bytes.byteLength,
    ...(image.sourceVersion === undefined ? {} : { sourceVersion: image.sourceVersion }),
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));

  const out = new Uint8Array(HEADER_OFFSET + headerBytes.byteLength + image.bytes.byteLength);
  out.set(MAGIC, 0);
  out[4] = FORMAT_VERSION;
  new DataView(out.buffer).setUint32(5, headerBytes.byteLength, true);
  out.set(headerBytes, HEADER_OFFSET);
  out.set(image.bytes, HEADER_OFFSET + headerBytes.byteLength);
  return out;
}

/** Returns null for anything that is not a complete, current-version entry. */
function decodeEntry(raw: Uint8Array): CachedImage | null {
  if (raw.byteLength < HEADER_OFFSET) return null;
  for (let i = 0; i < MAGIC.length; i++) if (raw[i] !== MAGIC[i]) return null;
  if (raw[4] !== FORMAT_VERSION) return null;

  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const headerLength = view.getUint32(5, true);
  const bodyStart = HEADER_OFFSET + headerLength;
  if (headerLength === 0 || bodyStart > raw.byteLength) return null;

  let header: EntryHeader;
  try {
    header = JSON.parse(new TextDecoder().decode(raw.subarray(HEADER_OFFSET, bodyStart)));
  } catch {
    return null;
  }

  const body = raw.subarray(bodyStart);
  // Belt and braces: rename should make truncation impossible, but a truncated
  // entry must never be served as a valid image.
  if (body.byteLength !== header.byteLength) return null;

  return {
    bytes: body,
    width: header.width,
    height: header.height,
    format: header.format,
    etag: header.etag,
    storedAt: header.storedAt,
    ...(header.sourceVersion === undefined ? {} : { sourceVersion: header.sourceVersion }),
  };
}

export function diskCache(options: DiskCacheOptions): ImageCache {
  const root = options.directory;
  const maxSize = parseSize(options.maxSize ?? "2GB");

  const index = new Map<string, IndexEntry>();
  let bytes = 0;
  let clock = 0;
  let ready: Promise<void> | null = null;

  // Two hex characters of the key: 256 subdirectories, so no single directory
  // accumulates hundreds of thousands of files.
  const shardOf = (key: string) => key.replace(/^bimg_/, "").slice(0, 2) || "00";
  const pathOf = (key: string) => join(root, shardOf(key), key);

  /**
   * Sweep stale temp files and rebuild the size index.
   *
   * Runs once, lazily. Temp files are always garbage on startup: any process
   * that could still be writing one died with it.
   */
  async function init(): Promise<void> {
    ready ??= (async () => {
      const glob = new Bun.Glob("**/*");
      try {
        for await (const relative of glob.scan({ cwd: root, onlyFiles: true, dot: true })) {
          const full = join(root, relative);

          if (relative.startsWith(`${TMP_DIR}/`) || relative.startsWith(`${TMP_DIR}\\`)) {
            await Bun.file(full).delete().catch(() => {});
            continue;
          }

          const key = relative.split(/[\\/]/).pop();
          if (!key) continue;
          const stat = await Bun.file(full).stat().catch(() => null);
          if (!stat) continue;

          index.set(key, { size: stat.size, storedAt: stat.mtimeMs, lastUsed: 0 });
          bytes += stat.size;
        }
      } catch {
        // A missing directory is fine — it appears on first write.
      }
      await evictUntilFits();
    })();
    return ready;
  }

  async function evictUntilFits(): Promise<void> {
    if (bytes <= maxSize) return;

    // Oldest-used first. Within a process that is true LRU; across a restart
    // `lastUsed` is 0 for everything and mtime decides, which is the best
    // ordering available without writing on every read.
    const victims = [...index.entries()].sort((a, b) => {
      const recency = a[1].lastUsed - b[1].lastUsed;
      return recency !== 0 ? recency : a[1].storedAt - b[1].storedAt;
    });

    for (const [key, entry] of victims) {
      if (bytes <= maxSize) break;
      index.delete(key);
      bytes -= entry.size;
      await Bun.file(pathOf(key)).delete().catch(() => {});
    }
  }

  return {
    name: "disk",

    async get(key: string): Promise<CachedImage | null> {
      await init();
      const entry = index.get(key);
      if (!entry) return null;

      const raw = await Bun.file(pathOf(key)).bytes().catch(() => null);
      if (!raw) {
        // Removed underneath us.
        index.delete(key);
        bytes -= entry.size;
        return null;
      }

      const decoded = decodeEntry(raw);
      if (!decoded) {
        // Corrupt or written by an older format version: drop it and miss.
        index.delete(key);
        bytes -= entry.size;
        await Bun.file(pathOf(key)).delete().catch(() => {});
        return null;
      }

      entry.lastUsed = ++clock;
      return decoded;
    },

    async set(key: string, image: CachedImage): Promise<void> {
      await init();
      const payload = encodeEntry(image);

      // An entry bigger than the whole budget would evict everything and then
      // be evicted itself. Refuse it instead.
      if (payload.byteLength > maxSize) return;

      const temp = join(root, TMP_DIR, `${key}.${Bun.randomUUIDv7()}`);
      const final = pathOf(key);

      try {
        // Bun.write creates parent directories; rename does not. The shard
        // directory therefore has to exist first, and a zero-length placeholder
        // is the cheapest way to make it. The rename overwrites it atomically a
        // moment later, and until then the key is absent from the index, so no
        // reader can see the placeholder.
        await Bun.write(temp, payload);
        await Bun.write(final, new Uint8Array(0));
        await rename(temp, final);
      } catch {
        // Clean up both halves. Leaving the placeholder behind would put a
        // zero-length file where an entry belongs; the next startup scan would
        // index it, the first read would fail to decode it and evict it, and the
        // cache would heal — but only after serving one avoidable miss.
        await Bun.file(temp).delete().catch(() => {});
        await Bun.file(final).delete().catch(() => {});
        return;
      }

      const previous = index.get(key);
      if (previous) bytes -= previous.size;
      index.set(key, {
        size: payload.byteLength,
        storedAt: image.storedAt,
        lastUsed: ++clock,
      });
      bytes += payload.byteLength;

      await evictUntilFits();
    },

    async delete(key: string): Promise<void> {
      await init();
      const entry = index.get(key);
      if (!entry) return;
      index.delete(key);
      bytes -= entry.size;
      await Bun.file(pathOf(key)).delete().catch(() => {});
    },

    async clear(): Promise<void> {
      await init();
      for (const key of [...index.keys()]) {
        await Bun.file(pathOf(key)).delete().catch(() => {});
      }
      index.clear();
      bytes = 0;
    },

    async size(): Promise<{ bytes: number; entries: number }> {
      await init();
      return { bytes, entries: index.size };
    },
  };
}
