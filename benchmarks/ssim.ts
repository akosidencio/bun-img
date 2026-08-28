/**
 * SSIM (Wang et al. 2004) on single-channel 8-bit data.
 *
 * Canonical parameters: 11x11 Gaussian window, sigma 1.5, K1=0.01, K2=0.03,
 * L=255. Returns the mean SSIM over all valid window positions.
 *
 * DSSIM is reported as (1 / SSIM) - 1, the same definition the `dssim` CLI uses,
 * so the numbers here are comparable to published figures.
 */

const WIN = 11;
const SIGMA = 1.5;
const K1 = 0.01;
const K2 = 0.03;
const L = 255;
const C1 = (K1 * L) ** 2;
const C2 = (K2 * L) ** 2;

/** Separable 1-D Gaussian kernel, normalized. */
const KERNEL = (() => {
  const half = (WIN - 1) / 2;
  const k = new Float64Array(WIN);
  let sum = 0;
  for (let i = 0; i < WIN; i++) {
    const x = i - half;
    k[i] = Math.exp(-(x * x) / (2 * SIGMA * SIGMA));
    sum += k[i];
  }
  for (let i = 0; i < WIN; i++) k[i] /= sum;
  return k;
})();

/** Gaussian blur with the separable kernel, cropping to valid positions only. */
function filterValid(src: Float64Array, w: number, h: number): { data: Float64Array; w: number; h: number } {
  const half = (WIN - 1) / 2;
  const vw = w - WIN + 1;
  const vh = h - WIN + 1;
  if (vw <= 0 || vh <= 0) throw new Error("image smaller than SSIM window");

  // horizontal pass: full height, valid width
  const tmp = new Float64Array(vw * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const trow = y * vw;
    for (let x = 0; x < vw; x++) {
      let acc = 0;
      for (let k = 0; k < WIN; k++) acc += src[row + x + k] * KERNEL[k];
      tmp[trow + x] = acc;
    }
  }

  // vertical pass: valid height
  const out = new Float64Array(vw * vh);
  for (let y = 0; y < vh; y++) {
    for (let x = 0; x < vw; x++) {
      let acc = 0;
      for (let k = 0; k < WIN; k++) acc += tmp[(y + k) * vw + x] * KERNEL[k];
      out[y * vw + x] = acc;
    }
  }
  void half;
  return { data: out, w: vw, h: vh };
}

export function ssim(a: Uint8Array, b: Uint8Array, w: number, h: number): number {
  if (a.length !== b.length) throw new Error(`size mismatch: ${a.length} vs ${b.length}`);

  const fa = new Float64Array(a.length);
  const fb = new Float64Array(b.length);
  const faa = new Float64Array(a.length);
  const fbb = new Float64Array(b.length);
  const fab = new Float64Array(a.length);

  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    fa[i] = x; fb[i] = y;
    faa[i] = x * x; fbb[i] = y * y; fab[i] = x * y;
  }

  const muA = filterValid(fa, w, h);
  const muB = filterValid(fb, w, h);
  const sAA = filterValid(faa, w, h);
  const sBB = filterValid(fbb, w, h);
  const sAB = filterValid(fab, w, h);

  const n = muA.data.length;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const ma = muA.data[i], mb = muB.data[i];
    const ma2 = ma * ma, mb2 = mb * mb, mab = ma * mb;
    const va = sAA.data[i] - ma2;
    const vb = sBB.data[i] - mb2;
    const vab = sAB.data[i] - mab;
    total += ((2 * mab + C1) * (2 * vab + C2)) / ((ma2 + mb2 + C1) * (va + vb + C2));
  }
  return total / n;
}

export const dssim = (s: number) => 1 / s - 1;

/**
 * Bytes required to reach a target SSIM, by linear interpolation between the
 * two sweep points that bracket it. Returns null when the curve never reaches
 * the target (the encoder cannot hit that quality at any tested setting).
 */
export function bytesAtSSIM(
  points: Array<{ quality: number; bytes: number; ssim: number }>,
  target: number,
): number | null {
  const sorted = [...points].sort((p, q) => p.ssim - q.ssim);
  if (sorted[sorted.length - 1].ssim < target) return null;
  if (sorted[0].ssim >= target) return sorted[0].bytes;

  for (let i = 0; i < sorted.length - 1; i++) {
    const lo = sorted[i], hi = sorted[i + 1];
    if (lo.ssim <= target && target <= hi.ssim) {
      const t = (target - lo.ssim) / (hi.ssim - lo.ssim || 1);
      return lo.bytes + t * (hi.bytes - lo.bytes);
    }
  }
  return null;
}
