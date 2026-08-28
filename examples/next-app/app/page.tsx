import Image from "next/image";

/**
 * Unchanged application code — this is the point of the adapter. `next/image`
 * is used exactly as it would be with Next's own optimizer; only the
 * transformation backend has moved.
 */
export default function Page() {
  return (
    <main>
      <h1>bun-img × next/image</h1>
      <p>
        Served by <code>bun-img/next</code>. No Sharp, no libvips, no native
        install step.
      </p>

      <Image
        src="/hero.png"
        width={1920}
        height={1080}
        quality={75}
        alt="Example"
        sizes="(max-width: 768px) 100vw, 1024px"
        priority
        style={{ width: "100%", height: "auto", borderRadius: 4 }}
      />

      <p>
        View source on the <code>&lt;img&gt;</code> above: its <code>srcset</code>{" "}
        points at <code>/_image/w_…,q_75,f_auto/hero.png</code>.
      </p>
    </main>
  );
}
