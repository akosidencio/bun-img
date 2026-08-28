/**
 * The architectural rule, enforced rather than documented.
 *
 * `@bun-img/core` must never depend on a framework — or on anything at all.
 * Adapters depend on core; core depends on Bun. Without a test, this decays the
 * first time someone reaches for a convenience package.
 */
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const PKG_ROOT = new URL("../", import.meta.url).pathname;
const SRC = join(PKG_ROOT, "src");

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

const FRAMEWORKS = ["next", "nuxt", "astro", "react", "svelte", "vue", "hono", "elysia", "sharp"];

describe("package boundary", () => {
  test("core declares no dependencies", async () => {
    const pkg = await Bun.file(join(PKG_ROOT, "package.json")).json();
    expect(pkg.dependencies).toEqual({});
    expect(pkg.peerDependencies).toBeUndefined();
  });

  /**
   * `node:` specifiers are runtime builtins, not packages. Under Bun they are
   * Bun's own Zig implementations — importing `node:path` pulls in no Node.js
   * and installs nothing. They are allowed only where Bun ships no native
   * equivalent, which today is exactly `node:path` and `realpath`.
   */
  const ALLOWED_BUILTINS = new Set(["node:path", "node:fs/promises"]);

  test("no source file imports a package — only relative paths and runtime builtins", async () => {
    const files = await sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(5);

    for (const file of files) {
      const text = await Bun.file(file).text();
      const imports = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
      for (const spec of imports) {
        const ok = spec.startsWith(".") || ALLOWED_BUILTINS.has(spec);
        expect({ file, spec, ok }).toEqual({ file, spec, ok: true });
        for (const framework of FRAMEWORKS) {
          expect(spec).not.toContain(framework);
        }
      }
    }
  });

  test("node: builtins are used only where Bun has no native equivalent", async () => {
    // Bun ships no realpath and no path module. Everything else — file reads,
    // stat, DNS, hashing — goes through the Bun API directly.
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const text = await Bun.file(file).text();
      for (const spec of [...text.matchAll(/from\s+"(node:[^"]+)"/g)].map((m) => m[1]!)) {
        offenders.push(`${file.slice(SRC.length + 1)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([
      "sources/local.ts -> node:fs/promises",
      "sources/local.ts -> node:path",
    ]);
  });

  test("filesystem and DNS go through Bun, not node:fs or node:dns", async () => {
    for (const file of await sourceFiles(SRC)) {
      const text = await Bun.file(file).text();
      expect(text).not.toContain('from "node:dns');
      // node:fs is permitted only for realpath, which Bun does not provide.
      const fsImport = text.match(/import \{([^}]*)\} from "node:fs\/promises"/);
      if (fsImport) {
        const named = fsImport[1]!.split(",").map((n) => n.trim()).filter(Boolean);
        expect(named).toEqual(["realpath"]);
      }
    }
  });

  test("no source file reaches into node_modules", async () => {
    for (const file of await sourceFiles(SRC)) {
      const text = await Bun.file(file).text();
      expect(text).not.toContain("node_modules");
    }
  });
});

describe("browser safety", () => {
  /**
   * Adapters generate `srcset` on the client, so URL building must not drag
   * `Bun.Image` into a browser bundle. Anything reachable from `./url` has to
   * stay free of Bun APIs.
   */
  const stripComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  test("the url entrypoint touches no Bun API", async () => {
    for (const file of [join(SRC, "url", "index.ts"), join(SRC, "url", "ops.ts")]) {
      const code = stripComments(await Bun.file(file).text());
      expect(code).not.toContain("Bun.");
      expect(code).not.toContain("new Bun");
    }
  });

  test("the url entrypoint imports only types and errors", async () => {
    const text = await Bun.file(join(SRC, "url", "index.ts")).text();
    const imports = [...text.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
    for (const spec of imports) {
      expect(["../types.ts", "../errors.ts", "./ops.ts"]).toContain(spec);
    }
  });

  test("errors.ts, which url depends on, touches no Bun API", async () => {
    const code = stripComments(await Bun.file(join(SRC, "errors.ts")).text());
    expect(code).not.toContain("Bun.");
  });
});

describe("guard", () => {
  test("assertBunImage passes on Bun", async () => {
    const { assertBunImage } = await import("../src/guard.ts");
    expect(() => assertBunImage()).not.toThrow();
  });

  test("the guard runs at engine construction, not at import", async () => {
    // Importing the package must stay safe in a browser bundle; only building
    // an engine requires Bun.Image.
    const index = await Bun.file(join(SRC, "index.ts")).text();
    expect(index).not.toContain("assertBunImage()");
  });
});

describe("public API", () => {
  test("exports everything an adapter needs", async () => {
    const api = await import("../src/index.ts");
    const expected = [
      "createImageEngine", "capabilities", "resolveConfig",
      "ImageError", "toImageError", "messageFor",
      "normalize", "quantizeWidth", "quantizeQuality",
      "negotiate", "parseAccept", "fallbackFor",
      "cacheKey", "canonicalString", "etagFor",
      "runTransform", "readSourceInfo", "placeholder", "contentTypeFor",
      "imageUrl", "imageQueryUrl", "parseImageRequest", "srcset",
      "assertBunImage",
    ];
    for (const name of expected) {
      expect(api).toHaveProperty(name);
    }
  });
});
