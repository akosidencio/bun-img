/**
 * Local filesystem sources.
 *
 * Containment is asserted on the *real* path, after symlinks are resolved. A
 * `startsWith(root)` check on the lexical path is not enough: a symlink inside
 * the root pointing at `/etc` passes that check and serves the file anyway.
 *
 * The spec draft's threat list (§20) covered SSRF thoroughly and did not mention
 * path traversal at all, which is the more likely of the two to be reachable in
 * a default deployment.
 */
// `node:path` and `realpath` are the only two things here without a Bun-native
// equivalent; they resolve to Bun's own built-ins rather than to Node.js.
// Everything else goes through the Bun API directly.
import { realpath } from "node:fs/promises";
import { isAbsolute, normalize, resolve, sep } from "node:path";
import { ImageError } from "../errors.ts";
import type { SourceIdentity } from "../types.ts";
import type { ResolveContext, ResolvedSource, SourceResolver } from "./types.ts";

export interface LocalSourceOptions {
  /** Directory that every resolved path must stay inside. */
  root: string;
  /** Serve dotfiles. Off by default — `.env` and `.git` live in public dirs. */
  allowDotfiles?: boolean;
}

function notFound(): never {
  // Deliberately indistinguishable from a genuinely missing file: a distinct
  // "forbidden" would confirm the path exists.
  throw new ImageError("SOURCE_NOT_FOUND", 404, "source not found");
}

interface Located {
  readonly real: string;
  readonly root: string;
  readonly mtimeMs: number;
  readonly size: number;
}

export function createLocalResolver(options: LocalSourceOptions): SourceResolver {
  const allowDotfiles = options.allowDotfiles ?? false;
  let realRootPromise: Promise<string> | null = null;

  const realRoot = () => {
    // Resolved once, lazily: the root may not exist when the engine is built.
    realRootPromise ??= realpath(resolve(options.root)).catch(() => {
      throw new ImageError(
        "INTERNAL_ERROR",
        500,
        `local source root does not exist: ${options.root}`,
      );
    });
    return realRootPromise;
  };

  /**
   * Validate, contain, and stat — the whole security-relevant path, shared by
   * `identify` and `resolve` so the two can never drift apart. A cheaper
   * identity check that skipped a containment step would be a hole.
   */
  async function locate(source: string): Promise<Located> {
    let decoded: string;
    try {
      decoded = decodeURIComponent(source);
    } catch {
      throw new ImageError("INVALID_REQUEST", 400, "malformed percent-encoding in source path");
    }

    // A NUL truncates the path in some syscall layers, so `a.jpg\0.txt` can
    // become `a.jpg`. Never let one through.
    if (decoded.includes("\0")) {
      throw new ImageError("INVALID_REQUEST", 400, "null byte in source path");
    }

    if (!allowDotfiles && decoded.split(/[\\/]/).some((part) => part.startsWith("."))) {
      // Covers `.env` and `.git/config` as well as any `..` that survived.
      notFound();
    }

    // Force the path to be root-relative before resolving: `/etc/passwd` and
    // `../../etc/passwd` both become candidates *under* the root, and the
    // realpath check below then has the final word.
    const rooted = normalize(`/${decoded}`);
    const candidate = resolve(options.root, `.${rooted}`);
    if (!isAbsolute(candidate)) notFound();

    const root = await realRoot();

    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      notFound();
    }

    // The containment check that actually matters. `real !== root` guards the
    // root itself; the separator prevents `/srv/public-secrets` from passing a
    // `/srv/public` prefix test.
    if (real !== root && !real.startsWith(root + sep)) notFound();

    const info = await Bun.file(real).stat().catch(() => notFound());
    if (!info.isFile()) notFound();

    return { real, root, mtimeMs: info.mtimeMs, size: info.size };
  }

  const identityOf = (located: Located): SourceIdentity => ({
    id: `local:${located.real.slice(located.root.length) || sep}`,
    // mtime plus size changes whenever the bytes do, which is what the cache
    // key needs; mtime alone misses same-second rewrites.
    version: `${Math.trunc(located.mtimeMs)}:${located.size}`,
  });

  return {
    name: "local",

    supports(source: string): boolean {
      // Anything that is not an absolute URL. Protocol-relative `//host/path` is
      // excluded because it is a remote reference wearing a path's clothes.
      if (source.startsWith("//")) return false;
      return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(source);
    },

    async identify(source: string, _context: ResolveContext): Promise<SourceIdentity> {
      // A stat, and nothing more — cheap enough to run on every request, which
      // is what lets a cache hit avoid opening the file at all.
      return identityOf(await locate(source));
    },

    async resolve(source: string, _context: ResolveContext): Promise<ResolvedSource> {
      const located = await locate(source);
      return {
        data: Bun.file(located.real),
        kind: "local",
        identity: identityOf(located),
      };
    },
  };
}
