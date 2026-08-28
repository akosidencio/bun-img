/**
 * The `next/image` custom loader.
 *
 * Next imports this file into the **client bundle**, so it must not touch Bun,
 * Node, or anything server-side. It gets exactly three inputs — `src`, `width`,
 * `quality` — and no access to engine config or the `Accept` header.
 *
 * That last constraint is why the loader emits `f=auto` rather than choosing a
 * format: format selection depends on `Accept`, which only the server sees, so
 * negotiation happens at the endpoint. Trying to decide here would mean either
 * guessing or shipping the same format to every client.
 *
 * Next requires a **default export** from the file named by `images.loaderFile`.
 */

export interface NextLoaderParams {
  src: string;
  width: number;
  quality?: number;
}

/**
 * Build one URL. Kept dependency-free and inlined rather than importing the
 * core URL builder, because Next resolves `loaderFile` as a standalone module
 * in the client graph and a bare import here would follow it into the bundle.
 */
export function buildLoaderUrl(
  { src, width, quality }: NextLoaderParams,
  basePath = "/_image",
): string {
  const ops = [`w_${width}`];
  if (quality !== undefined) ops.push(`q_${quality}`);
  // Negotiation is the server's job; see the note above.
  ops.push("f_auto");

  // Remote sources cannot be expressed in the operation-path form, so they take
  // the query protocol. Both resolve to the same normalized transform.
  if (/^https?:\/\//i.test(src)) {
    const params = new URLSearchParams({ url: src, w: String(width), f: "auto" });
    if (quality !== undefined) params.set("q", String(quality));
    return `${basePath}?${params.toString()}`;
  }

  const clean = src.startsWith("/") ? src.slice(1) : src;
  const encoded = clean.split("/").map(encodeURIComponent).join("/");
  return `${basePath}/${ops.join(",")}/${encoded}`;
}

export default function bunImageLoader(params: NextLoaderParams): string {
  return buildLoaderUrl(params);
}
