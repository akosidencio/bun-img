/**
 * Portable fixture loading.
 *
 * The manifest records a bare `name` for each fixture, never an absolute path,
 * so the same fixture directory works on the host and inside a container. Paths
 * are resolved relative to this module.
 */
export interface Fixture {
  id: string;
  name: string;
  kind: "jpeg" | "png" | "png-alpha";
  character: string;
  width: number;
  height: number;
  bytes: number;
  /** Absolute path, resolved for wherever this is running. */
  file: string;
}

export async function loadFixtures(): Promise<Fixture[]> {
  const dir = new URL("./fixtures/", import.meta.url);
  const manifest = await Bun.file(new URL("manifest.json", dir)).json();
  return manifest.map((f: any) => ({
    ...f,
    // tolerate manifests written before `name` existed
    name: f.name ?? f.file.split("/").pop(),
    file: new URL(f.name ?? f.file.split("/").pop(), dir).pathname,
  }));
}

export async function fixture(id: string): Promise<Fixture> {
  const all = await loadFixtures();
  const f = all.find((x) => x.id === id);
  if (!f) throw new Error(`no fixture "${id}" (have: ${all.map((x) => x.id).join(", ")})`);
  return f;
}
