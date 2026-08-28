/**
 * IP address classification for SSRF defence.
 *
 * The rule is allow-nothing-by-default: an address is fetchable only if it is a
 * well-formed public unicast address. Anything unparseable, reserved, private,
 * or ambiguous is refused.
 *
 * Parsing is deliberately strict. `010.0.0.1` (octal), `0x7f.1` (hex), and
 * `2130706433` (integer) all resolve to loopback in many resolvers but would
 * sail past a naive dotted-quad regex, so anything that is not exactly four
 * decimal octets is not treated as an IPv4 literal at all — it falls through to
 * hostname handling, where DNS resolution then decides, and the resolved
 * address gets classified here anyway.
 */

export type IpVersion = 4 | 6;

export interface BlockedRange {
  readonly cidr: string;
  readonly why: string;
}

/* ──────────────────────────── parsing ───────────────────────────────────── */

/** Parse a strict dotted-quad into a 32-bit unsigned integer, or null. */
export function parseIPv4(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    // No leading zeros: "010" is octal in some resolvers and 10 in others.
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    result = result * 256 + octet;
  }
  return result >>> 0;
}

/** Parse an IPv6 literal into eight 16-bit groups, or null. */
export function parseIPv6(value: string): number[] | null {
  let text = value;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  // A zone index (fe80::1%eth0) never denotes a routable public address.
  if (text.includes("%")) return null;
  if (!text.includes(":")) return null;

  // A trailing IPv4 form (::ffff:127.0.0.1) contributes two groups.
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const afterColon = text.slice(lastColon + 1);
  if (afterColon.includes(".")) {
    const v4 = parseIPv4(afterColon);
    if (v4 === null) return null;
    tail = [(v4 >>> 16) & 0xffff, v4 & 0xffff];
    text = text.slice(0, lastColon + 1) + "0:0";
  }

  const doubleColon = text.indexOf("::");
  if (doubleColon !== -1 && text.indexOf("::", doubleColon + 1) !== -1) return null;

  const parseGroups = (s: string): number[] | null => {
    if (s.length === 0) return [];
    const out: number[] = [];
    for (const group of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(Number.parseInt(group, 16));
    }
    return out;
  };

  let groups: number[];
  if (doubleColon === -1) {
    const parsed = parseGroups(text);
    if (parsed === null || parsed.length !== 8) return null;
    groups = parsed;
  } else {
    const head = parseGroups(text.slice(0, doubleColon));
    const rest = parseGroups(text.slice(doubleColon + 2));
    if (head === null || rest === null) return null;
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...rest];
  }

  if (tail.length === 2) {
    groups[6] = tail[0]!;
    groups[7] = tail[1]!;
  }
  return groups;
}

/** Is this string an IP literal of either family? */
export function isIpLiteral(value: string): boolean {
  return parseIPv4(value) !== null || parseIPv6(value) !== null;
}

/* ──────────────────────────── classification ────────────────────────────── */

const v4 = (a: number, b: number, c: number, d: number) =>
  ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;

const V4_BLOCKS: ReadonlyArray<{ base: number; bits: number; why: string }> = [
  { base: v4(0, 0, 0, 0), bits: 8, why: "this-network" },
  { base: v4(10, 0, 0, 0), bits: 8, why: "private (RFC1918)" },
  { base: v4(100, 64, 0, 0), bits: 10, why: "carrier-grade NAT" },
  { base: v4(127, 0, 0, 0), bits: 8, why: "loopback" },
  { base: v4(169, 254, 0, 0), bits: 16, why: "link-local / cloud metadata" },
  { base: v4(172, 16, 0, 0), bits: 12, why: "private (RFC1918)" },
  { base: v4(192, 0, 0, 0), bits: 24, why: "IETF protocol assignments" },
  { base: v4(192, 0, 2, 0), bits: 24, why: "documentation (TEST-NET-1)" },
  { base: v4(192, 168, 0, 0), bits: 16, why: "private (RFC1918)" },
  { base: v4(198, 18, 0, 0), bits: 15, why: "benchmarking" },
  { base: v4(198, 51, 100, 0), bits: 24, why: "documentation (TEST-NET-2)" },
  { base: v4(203, 0, 113, 0), bits: 24, why: "documentation (TEST-NET-3)" },
  { base: v4(224, 0, 0, 0), bits: 4, why: "multicast" },
  { base: v4(240, 0, 0, 0), bits: 4, why: "reserved / broadcast" },
];

function classifyV4(address: number): string | null {
  for (const { base, bits, why } of V4_BLOCKS) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((address & mask) >>> 0 === base) return why;
  }
  return null;
}

function classifyV6(groups: number[]): string | null {
  const [g0, g1, g2, g3, g4, g5] = groups as [number, number, number, number, number, number];

  const allZeroThrough = (n: number) => groups.slice(0, n).every((g) => g === 0);

  // ::/128 and ::1/128
  if (allZeroThrough(7) && groups[7] === 0) return "unspecified";
  if (allZeroThrough(7) && groups[7] === 1) return "loopback";

  // ::ffff:0:0/96 — IPv4-mapped. Unwrap and judge the embedded v4 address, or a
  // request for ::ffff:127.0.0.1 would walk straight past the v4 blocklist.
  if (allZeroThrough(5) && g5 === 0xffff) {
    const embedded = ((g6(groups) << 16) | g7(groups)) >>> 0;
    return classifyV4(embedded) ?? "IPv4-mapped";
  }

  // 64:ff9b::/96 — NAT64. Same unwrapping argument.
  if (g0 === 0x0064 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    const embedded = ((g6(groups) << 16) | g7(groups)) >>> 0;
    return classifyV4(embedded) ?? "NAT64";
  }

  if (g0 === 0x0100 && g1 === 0 && g2 === 0 && g3 === 0) return "discard-only";
  if (g0 === 0x2001 && g1 === 0x0db8) return "documentation";
  if ((g0 & 0xfe00) === 0xfc00) return "unique local (fc00::/7)";
  if ((g0 & 0xffc0) === 0xfe80) return "link-local (fe80::/10)";
  if ((g0 & 0xff00) === 0xff00) return "multicast";

  return null;
}

const g6 = (groups: number[]) => groups[6]!;
const g7 = (groups: number[]) => groups[7]!;

export interface IpVerdict {
  readonly allowed: boolean;
  readonly version?: IpVersion;
  /** Present when blocked: why, for logs. Never returned to the client. */
  readonly reason?: string;
}

/**
 * Classify a resolved address.
 *
 * Anything unparseable is blocked rather than passed through — a value that
 * reached here was supposed to be an address.
 */
export function classifyIp(value: string): IpVerdict {
  const address = parseIPv4(value);
  if (address !== null) {
    const reason = classifyV4(address);
    return reason === null ? { allowed: true, version: 4 } : { allowed: false, version: 4, reason };
  }

  const groups = parseIPv6(value);
  if (groups !== null) {
    const reason = classifyV6(groups);
    return reason === null ? { allowed: true, version: 6 } : { allowed: false, version: 6, reason };
  }

  return { allowed: false, reason: "not a valid IP address" };
}

/* ──────────────────────────── hostnames ─────────────────────────────────── */

/** Suffixes that only ever name something inside the perimeter. */
const PRIVATE_SUFFIXES = [".local", ".localhost", ".internal", ".intranet", ".home.arpa"];

/**
 * Reject hostnames that name internal infrastructure, before any DNS happens.
 *
 * This is a cheap pre-filter, not the defence — the defence is classifying every
 * address DNS returns. `metadata.google.internal` is caught here; a public name
 * that resolves to 169.254.169.254 is caught after resolution.
 */
export function hostnameVerdict(hostname: string): IpVerdict {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (host.length === 0) return { allowed: false, reason: "empty hostname" };
  if (host === "localhost") return { allowed: false, reason: "localhost" };
  for (const suffix of PRIVATE_SUFFIXES) {
    if (host.endsWith(suffix)) return { allowed: false, reason: `private suffix ${suffix}` };
  }
  if (isIpLiteral(host)) return classifyIp(host);
  return { allowed: true };
}
