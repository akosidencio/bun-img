/**
 * Rewrite `.ts` import specifiers to `.js` in emitted declarations.
 *
 * TypeScript's `rewriteRelativeImportExtensions` rewrites the specifiers in
 * emitted **JavaScript**, but leaves them alone in emitted **declarations**. So
 * `dist/index.js` correctly says `from "./engine.js"` while `dist/index.d.ts`
 * still says `from "./engine.ts"` — pointing at a file that does not exist in
 * the published package, and which a consumer could not import anyway without
 * `allowImportingTsExtensions`.
 *
 * The result is a package whose runtime works and whose types silently do not.
 * CI catches it; this fixes it.
 *
 * Only *relative* specifiers are touched. `node:fs/promises` and any bare
 * package name are left exactly as they are.
 */
import { join } from "node:path";

const DIST = join(import.meta.dir, "..", "dist");

/** `from "./x.ts"`, `import("./x.ts")`, and the `export … from` form. */
const SPECIFIER = /(\bfrom\s*|import\s*\(\s*)(["'])(\.[^"']*)\.ts\2/g;

let filesChanged = 0;
let specifiersRewritten = 0;

for await (const relative of new Bun.Glob("**/*.d.ts").scan({ cwd: DIST })) {
  const path = join(DIST, relative);
  const before = await Bun.file(path).text();

  const after = before.replace(SPECIFIER, (_match, prefix, quote, target) => {
    specifiersRewritten++;
    return `${prefix}${quote}${target}.js${quote}`;
  });

  if (after !== before) {
    await Bun.write(path, after);
    filesChanged++;
  }
}

// A silent no-op would be indistinguishable from "TypeScript started doing this
// itself", so say which happened.
if (filesChanged === 0) {
  console.log("declarations: no .ts specifiers found (nothing to rewrite)");
} else {
  console.log(
    `declarations: rewrote ${specifiersRewritten} .ts specifier(s) across ${filesChanged} file(s)`,
  );
}

// Fail loudly rather than shipping types that cannot resolve.
const leftovers: string[] = [];
for await (const relative of new Bun.Glob("**/*.d.ts").scan({ cwd: DIST })) {
  const text = await Bun.file(join(DIST, relative)).text();
  if (SPECIFIER.test(text)) leftovers.push(relative);
  SPECIFIER.lastIndex = 0;
}

if (leftovers.length > 0) {
  console.error(`declarations still contain .ts specifiers:\n  ${leftovers.join("\n  ")}`);
  process.exit(1);
}
