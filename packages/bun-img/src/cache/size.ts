/**
 * Human byte sizes: `"256MB"`, `"1.5 GiB"`, `"2gb"`, or a raw number.
 *
 * Both conventions are accepted and they mean different things: `MB` is 10^6
 * and `MiB` is 2^20, as the units actually say. Silently treating `MB` as
 * `MiB` would make a stated 2 GB budget quietly 7% larger than the container
 * limit it was chosen to fit under.
 */

const UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1_000,
  mb: 1_000_000,
  gb: 1_000_000_000,
  tb: 1_000_000_000_000,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

export function parseSize(value: string | number): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError(`invalid size: ${value}`);
    }
    return Math.floor(value);
  }

  const match = /^\s*([0-9]*\.?[0-9]+)\s*([a-zA-Z]*)\s*$/.exec(value);
  if (!match) throw new TypeError(`invalid size: ${JSON.stringify(value)}`);

  const amount = Number.parseFloat(match[1]!);
  const unit = (match[2] ?? "").toLowerCase() || "b";
  const multiplier = UNITS[unit];
  if (multiplier === undefined) {
    throw new TypeError(`unknown size unit: ${JSON.stringify(match[2])}`);
  }

  return Math.floor(amount * multiplier);
}

export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes}B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(1)}KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)}GB`;
}
