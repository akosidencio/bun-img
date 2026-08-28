/**
 * Layering, enforced.
 *
 * `bun-img` ships as one unscoped package, so the separation between engine,
 * server and adapter is no longer expressed by package boundaries. It has to be
 * expressed here instead, or it decays the first time someone reaches sideways.
 *
 *   src/**        the engine. Knows nothing about HTTP or any framework.
 *   src/server/** the HTTP endpoint. May use the engine.
 *   src/next/**   the Next adapter. May use both.
 *
 * The arrows only ever point inward.
 */
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

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

/** Real imports only — a `from "…"` inside a JSDoc example is not one. */
const importsOf = (text: string) => {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return [...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]!);
};

/** Which layer a file belongs to, by path. */
function layerOf(file: string): "core" | "server" | "next" {
  const rel = relative(SRC, file);
  if (rel.startsWith("server/")) return "server";
  if (rel.startsWith("next/")) return "next";
  return "core";
}

/** Which layer an import resolves into, from the importing file. */
function targetLayer(file: string, spec: string): "core" | "server" | "next" | "external" {
  if (!spec.startsWith(".")) return "external";
  const resolved = relative(SRC, join(file, "..", spec));
  if (resolved.startsWith("server/")) return "server";
  if (resolved.startsWith("next/")) return "next";
  return "core";
}

const FRAMEWORKS = ["next", "nuxt", "astro", "react", "svelte", "vue", "hono", "elysia", "sharp"];

describe("layering", () => {
  test("the engine never reaches out to the server or an adapter", async () => {
    for (const file of await sourceFiles(SRC)) {
      if (layerOf(file) !== "core") continue;
      for (const spec of importsOf(await Bun.file(file).text())) {
        const target = targetLayer(file, spec);
        expect({ file: relative(SRC, file), spec, target }).toEqual({
          file: relative(SRC, file),
          spec,
          target: target === "core" || target === "external" ? target : "core",
        });
      }
    }
  });

  test("the server may use the engine but not the Next adapter", async () => {
    for (const file of await sourceFiles(SRC)) {
      if (layerOf(file) !== "server") continue;
      for (const spec of importsOf(await Bun.file(file).text())) {
        expect(targetLayer(file, spec)).not.toBe("next");
      }
    }
  });
});

describe("dependencies", () => {
  test("the package declares none", async () => {
    const pkg = await Bun.file(join(PKG_ROOT, "package.json")).json();
    expect(pkg.dependencies).toEqual({});
    expect(pkg.peerDependencies).toBeUndefined();
  });

  test("no framework is ever imported, including by the adapter", async () => {
    // The Next adapter translates Next's config shape; it does not depend on
    // Next, which is what keeps it installable without one.
    //
    // Only *bare* specifiers can name a package — `../next/loader.ts` is our own
    // directory, and matching on substring alone would flag it.
    for (const file of await sourceFiles(SRC)) {
      for (const spec of importsOf(await Bun.file(file).text())) {
        if (spec.startsWith(".") || spec.startsWith("node:")) continue;
        for (const framework of FRAMEWORKS) expect(spec).not.toContain(framework);
      }
    }
  });

  /**
   * `node:` specifiers are runtime builtins, not packages: they resolve to Bun's
   * own implementations, so importing `node:path` pulls in no Node.js and
   * installs nothing. They are allowed only where Bun ships no equivalent.
   */
  test("node: builtins appear only where Bun has no equivalent", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const text = await Bun.file(file).text();
      for (const spec of importsOf(text)) {
        if (spec.startsWith("node:")) offenders.push(`${relative(SRC, file)} -> ${spec}`);
      }
    }
    expect(offenders.sort()).toEqual([
      // rename: the atomic tmp -> final move that makes the disk cache
      // crash-safe. Bun has no equivalent.
      "cache/disk.ts -> node:fs/promises",
      "cache/disk.ts -> node:path",
      // realpath: symlink-resolving containment. Bun has no equivalent.
      "sources/local.ts -> node:fs/promises",
      "sources/local.ts -> node:path",
    ]);
  });

  test("filesystem and DNS go through Bun, not node:fs or node:dns", async () => {
    for (const file of await sourceFiles(SRC)) {
      const text = await Bun.file(file).text();
      expect(text).not.toContain('from "node:dns');
      const fsImport = text.match(/import \{([^}]*)\} from "node:fs\/promises"/);
      if (fsImport) {
        for (const name of fsImport[1]!.split(",").map((n) => n.trim()).filter(Boolean)) {
          expect(["realpath", "rename"]).toContain(name);
        }
      }
    }
  });
});

describe("browser safety", () => {
  const stripComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  test("the url entrypoint touches no Bun API", async () => {
    // Adapters build srcset on the client; dragging Bun.Image into a browser
    // bundle would break them.
    for (const file of [join(SRC, "url", "index.ts"), join(SRC, "url", "ops.ts")]) {
      const code = stripComments(await Bun.file(file).text());
      expect(code).not.toContain("Bun.");
    }
  });

  test("errors.ts, which url depends on, touches no Bun API", async () => {
    expect(stripComments(await Bun.file(join(SRC, "errors.ts")).text())).not.toContain("Bun.");
  });

  test("the Next loader stays client-safe and standalone", async () => {
    // Next bundles this file for the browser and resolves it as its own module.
    // Anything server-side here breaks the build, or worse, ships.
    const code = stripComments(await Bun.file(join(SRC, "next", "loader.ts")).text());
    expect(code).not.toContain("Bun.");
    expect(code).not.toContain("node:");
    expect(code).not.toContain("import ");
  });

  test("the server handler touches no Bun API", async () => {
    // Request/Response/Headers/URL only, so it runs on any Web-API host.
    const code = stripComments(await Bun.file(join(SRC, "server", "handler.ts")).text());
    expect(code).not.toContain("Bun.");
  });

  test("the guard runs at engine construction, not at import", async () => {
    const index = await Bun.file(join(SRC, "index.ts")).text();
    expect(index).not.toContain("assertBunImage()");
  });
});

describe("public API", () => {
  test("the root entrypoint exports the engine", async () => {
    const api = await import("../src/index.ts");
    for (const name of [
      "createImageEngine", "capabilities", "resolveConfig",
      "ImageError", "normalize", "negotiate", "cacheKey", "etagFor",
      "runTransform", "bytesToBlob", "imageUrl", "srcset", "parseImageRequest",
      "memoryCache", "diskCache", "createSemaphore", "createCoalescer",
      "createLocalResolver", "createRemoteResolver",
    ]) {
      expect(api).toHaveProperty(name);
    }
  });

  test("the server subpath exports the handler", async () => {
    const api = await import("../src/server/index.ts");
    expect(api).toHaveProperty("createImageServer");
    expect(api).toHaveProperty("etagMatches");
  });

  test("the next subpath exports the adapter and a default loader", async () => {
    const api = await import("../src/next/index.ts");
    expect(api).toHaveProperty("withBunImage");
    expect(api).toHaveProperty("createNextImageRoute");

    const loader = await import("../src/next/loader.ts");
    expect(typeof loader.default).toBe("function");
  });

  test("every exports subpath in package.json resolves", async () => {
    const pkg = await Bun.file(join(PKG_ROOT, "package.json")).json();
    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      if (subpath === "./package.json") continue;
      const bunEntry = (entry as { bun: string }).bun;
      expect(await Bun.file(join(PKG_ROOT, bunEntry)).exists()).toBe(true);
    }
  });
});
