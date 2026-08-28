import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalResolver } from "../../src/sources/local.ts";
import { resolveConfig } from "../../src/config.ts";
import { expectCode, makeImage } from "../helpers.ts";

const cfg = resolveConfig();
const ctx = { config: cfg };

let base: string;
let root: string;
let outside: string;

beforeAll(async () => {
  base = join(tmpdir(), `bun-img-local-${Bun.randomUUIDv7()}`);
  root = join(base, "public");
  outside = join(base, "secrets");

  await mkdir(join(root, "images", "nested"), { recursive: true });
  await mkdir(outside, { recursive: true });

  await writeFile(join(root, "hero.png"), await makeImage(64, 64, "png"));
  await writeFile(join(root, "images", "nested", "deep.png"), await makeImage(32, 32, "png"));
  await writeFile(join(root, "a b.png"), await makeImage(16, 16, "png"));
  await writeFile(join(root, ".env"), "SECRET=hunter2");
  await writeFile(join(outside, "passwd.txt"), "root:x:0:0");

  // A symlink inside the root pointing outside it. This is what defeats a
  // lexical startsWith(root) check.
  await symlink(join(outside, "passwd.txt"), join(root, "escape.txt")).catch(() => {});
  await symlink(outside, join(root, "escape-dir")).catch(() => {});
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("supports", () => {
  const resolver = createLocalResolver({ root: "/tmp" });

  test("claims relative and absolute-looking paths", () => {
    expect(resolver.supports("hero.png")).toBe(true);
    expect(resolver.supports("/hero.png")).toBe(true);
    expect(resolver.supports("images/a.png")).toBe(true);
  });

  test("does not claim URLs", () => {
    expect(resolver.supports("https://example.com/a.png")).toBe(false);
    expect(resolver.supports("http://example.com/a.png")).toBe(false);
    expect(resolver.supports("data:image/png;base64,AAAA")).toBe(false);
    expect(resolver.supports("file:///etc/passwd")).toBe(false);
  });

  test("does not claim protocol-relative URLs", () => {
    // `//evil.com/a.png` is a remote reference wearing a path's clothes.
    expect(resolver.supports("//evil.com/a.png")).toBe(false);
  });
});

describe("resolving allowed paths", () => {
  test("resolves a file at the root", async () => {
    const resolver = createLocalResolver({ root });
    const out = await resolver.resolve("hero.png", ctx);
    expect(out.kind).toBe("local");
    expect(out.identity.id).toContain("hero.png");
    expect(await (out.data as Blob).bytes()).toHaveLength((await makeImage(64, 64, "png")).length);
  });

  test("resolves a nested file", async () => {
    const resolver = createLocalResolver({ root });
    const out = await resolver.resolve("images/nested/deep.png", ctx);
    expect(out.identity.id).toContain("deep.png");
  });

  test("accepts a leading slash as root-relative", async () => {
    const resolver = createLocalResolver({ root });
    const a = await resolver.resolve("/hero.png", ctx);
    const b = await resolver.resolve("hero.png", ctx);
    expect(a.identity.id).toBe(b.identity.id);
  });

  test("decodes percent-encoding", async () => {
    const resolver = createLocalResolver({ root });
    const out = await resolver.resolve("a%20b.png", ctx);
    expect(out.identity.id).toContain("a b.png");
  });

  test("version combines mtime and size so same-second rewrites are caught", async () => {
    const resolver = createLocalResolver({ root });
    const out = await resolver.resolve("hero.png", ctx);
    expect(out.identity.version).toMatch(/^\d+:\d+$/);
  });
});

describe("path traversal", () => {
  const traversals = [
    "../secrets/passwd.txt",
    "../../etc/passwd",
    "images/../../secrets/passwd.txt",
    "images/nested/../../../secrets/passwd.txt",
    "....//....//secrets/passwd.txt",
    "..%2Fsecrets%2Fpasswd.txt",
    "%2e%2e%2fsecrets%2fpasswd.txt",
    "/etc/passwd",
    "/../secrets/passwd.txt",
  ];

  for (const attempt of traversals) {
    test(`refuses ${attempt}`, async () => {
      const resolver = createLocalResolver({ root });
      await expectCode(() => resolver.resolve(attempt, ctx), "SOURCE_NOT_FOUND");
    });
  }

  test("refuses a null byte, which can truncate a path in syscall layers", async () => {
    const resolver = createLocalResolver({ root });
    await expectCode(() => resolver.resolve("hero.png\0.txt", ctx), "INVALID_REQUEST");
    await expectCode(() => resolver.resolve("hero.png%00.txt", ctx), "INVALID_REQUEST");
  });

  test("refuses malformed percent-encoding", async () => {
    const resolver = createLocalResolver({ root });
    await expectCode(() => resolver.resolve("%zz.png", ctx), "INVALID_REQUEST");
  });
});

describe("symlink escape", () => {
  test("refuses a symlink to a file outside the root", async () => {
    // The case a lexical startsWith(root) check would serve happily.
    const resolver = createLocalResolver({ root });
    await expectCode(() => resolver.resolve("escape.txt", ctx), "SOURCE_NOT_FOUND");
  });

  test("refuses a path through a symlinked directory", async () => {
    const resolver = createLocalResolver({ root });
    await expectCode(() => resolver.resolve("escape-dir/passwd.txt", ctx), "SOURCE_NOT_FOUND");
  });
});

describe("dotfiles", () => {
  test("refuses dotfiles by default", async () => {
    const resolver = createLocalResolver({ root });
    await expectCode(() => resolver.resolve(".env", ctx), "SOURCE_NOT_FOUND");
  });

  test("serves them when explicitly allowed", async () => {
    const resolver = createLocalResolver({ root, allowDotfiles: true });
    const out = await resolver.resolve(".env", ctx);
    expect(out.identity.id).toContain(".env");
  });
});

describe("error shape", () => {
  test("a missing file and a forbidden file are indistinguishable", async () => {
    // A distinct 403 would confirm that the forbidden path exists.
    const resolver = createLocalResolver({ root });
    const missing = await resolver.resolve("nope.png", ctx).catch((e) => e);
    const forbidden = await resolver.resolve("../secrets/passwd.txt", ctx).catch((e) => e);
    expect(missing.status).toBe(forbidden.status);
    expect(missing.message).toBe(forbidden.message);
  });

  test("refuses a directory", async () => {
    const resolver = createLocalResolver({ root });
    await expectCode(() => resolver.resolve("images", ctx), "SOURCE_NOT_FOUND");
  });

  test("reports a nonexistent root as a configuration error, not a 404", async () => {
    const resolver = createLocalResolver({ root: join(base, "does-not-exist") });
    await expectCode(() => resolver.resolve("a.png", ctx), "INTERNAL_ERROR");
  });

  test("a sibling directory sharing a name prefix is still outside", async () => {
    // /public must not admit /public-secrets.
    const sibling = `${root}-secrets`;
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "x.txt"), "nope");
    const resolver = createLocalResolver({ root });
    await expectCode(() => resolver.resolve("../public-secrets/x.txt", ctx), "SOURCE_NOT_FOUND");
  });
});
