/**
 * Verify the built package the way a consumer meets it.
 *
 * Grepping `dist` for `.ts` specifiers is a proxy, and a proxy is what let a
 * broken build through once already: the emitted JavaScript was clean while
 * every `.d.ts` still pointed at `.ts` files that are not published.
 *
 * This is the real check. It writes a throwaway consumer against the *built*
 * entrypoints and type-checks it with an ordinary web-app tsconfig — DOM lib,
 * `bundler` resolution, and no `allowImportingTsExtensions`. If the published
 * types cannot resolve under those settings, this fails.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

const PKG = join(import.meta.dir, "..");
const DIST = join(PKG, "dist");
const SCRATCH = join(PKG, ".verify");

const ENTRYPOINTS = [
  "index",
  "url/index",
  "server/index",
  "next/index",
  "next/loader",
  "astro/index",
];

// ── every declared entrypoint exists, with types ─────────────────────────────
const pkg = await Bun.file(join(PKG, "package.json")).json();
const missing: string[] = [];

for (const [subpath, entry] of Object.entries(pkg.exports as Record<string, unknown>)) {
  if (subpath === "./package.json") continue;
  const map = entry as { types?: string; default?: string };
  for (const file of [map.types, map.default]) {
    if (!file) continue;
    if (!(await Bun.file(join(PKG, file)).exists())) missing.push(`${subpath} -> ${file}`);
  }
}

if (missing.length > 0) {
  console.error(`declared exports that do not exist:\n  ${missing.join("\n  ")}`);
  process.exit(1);
}
console.log(`exports: ${Object.keys(pkg.exports).length - 1} entrypoints present with types`);

// ── the published types resolve under a plain web-app tsconfig ───────────────
await rm(SCRATCH, { recursive: true, force: true });

const imports = ENTRYPOINTS.map(
  (entry, i) => `import * as m${i} from "${join(DIST, entry).replaceAll("\\", "/")}.js";`,
).join("\n");

await Bun.write(
  join(SCRATCH, "consumer.ts"),
  `${imports}

// Touch a value from each entrypoint so the imports are not elided before the
// checker ever resolves them.
export const used = [
  m0.createImageEngine,
  m1.imageUrl,
  m2.createImageServer,
  m3.withBunImage,
  m4.default,
  m5.createBunImageService,
];
`,
);

await Bun.write(
  join(SCRATCH, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        // Deliberately *not* our config: this is what a typical Next or Astro
        // app compiles with, DOM lib included and no .ts-extension allowance.
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["DOM", "DOM.Iterable", "ESNext"],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
      include: ["consumer.ts"],
    },
    null,
    2,
  ),
);

const proc = Bun.spawn(["bunx", "tsc", "-p", join(SCRATCH, "tsconfig.json")], {
  stdout: "pipe",
  stderr: "pipe",
  cwd: PKG,
});
const output = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
await proc.exited;

await rm(SCRATCH, { recursive: true, force: true });

if (proc.exitCode !== 0) {
  console.error("the published types do not resolve for a consumer:\n");
  console.error(output.trim());
  process.exit(1);
}

console.log("types: resolve cleanly under DOM lib + bundler resolution, no .ts extensions");
