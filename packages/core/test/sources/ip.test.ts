import { describe, expect, test } from "bun:test";
import { classifyIp, hostnameVerdict, isIpLiteral, parseIPv4, parseIPv6 } from "../../src/sources/ip.ts";

describe("parseIPv4", () => {
  test("accepts strict dotted quads", () => {
    expect(parseIPv4("0.0.0.0")).toBe(0);
    expect(parseIPv4("127.0.0.1")).toBe(0x7f000001);
    expect(parseIPv4("255.255.255.255")).toBe(0xffffffff);
    expect(parseIPv4("8.8.8.8")).toBe(0x08080808);
  });

  test("rejects the ambiguous spellings that bypass naive checks", () => {
    // Every one of these reaches 127.0.0.1 through some resolver.
    expect(parseIPv4("010.0.0.1")).toBeNull(); // octal
    expect(parseIPv4("0x7f.0.0.1")).toBeNull(); // hex
    expect(parseIPv4("2130706433")).toBeNull(); // integer
    expect(parseIPv4("127.1")).toBeNull(); // short form
    expect(parseIPv4("127.0.0.01")).toBeNull(); // leading zero
  });

  test("rejects out-of-range and malformed input", () => {
    expect(parseIPv4("256.0.0.1")).toBeNull();
    expect(parseIPv4("1.2.3.4.5")).toBeNull();
    expect(parseIPv4("1.2.3")).toBeNull();
    expect(parseIPv4("a.b.c.d")).toBeNull();
    expect(parseIPv4("")).toBeNull();
    expect(parseIPv4(" 1.2.3.4")).toBeNull();
  });
});

describe("parseIPv6", () => {
  test("parses full, compressed and bracketed forms", () => {
    expect(parseIPv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("[::1]")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("2001:db8::1")).toEqual([0x2001, 0x0db8, 0, 0, 0, 0, 0, 1]);
    expect(parseIPv6("fe80:0:0:0:0:0:0:1")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
  });

  test("parses IPv4-mapped form", () => {
    expect(parseIPv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
  });

  test("rejects malformed input", () => {
    expect(parseIPv6("::1::2")).toBeNull();
    expect(parseIPv6("gggg::1")).toBeNull();
    expect(parseIPv6("1.2.3.4")).toBeNull();
    expect(parseIPv6("fe80::1%eth0")).toBeNull(); // zone index is never public
  });
});

describe("classifyIp — the blocklist", () => {
  const blocked: Array<[string, string]> = [
    ["0.0.0.0", "this-network"],
    ["10.0.0.1", "RFC1918"],
    ["10.255.255.255", "RFC1918"],
    ["100.64.0.1", "CGNAT"],
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback"],
    ["169.254.0.1", "link-local"],
    ["169.254.169.254", "cloud metadata"],
    ["172.16.0.1", "RFC1918"],
    ["172.31.255.255", "RFC1918"],
    ["192.0.0.1", "protocol assignments"],
    ["192.0.2.1", "TEST-NET-1"],
    ["192.168.0.1", "RFC1918"],
    ["192.168.255.255", "RFC1918"],
    ["198.18.0.1", "benchmarking"],
    ["198.51.100.1", "TEST-NET-2"],
    ["203.0.113.1", "TEST-NET-3"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ];

  for (const [address, why] of blocked) {
    test(`blocks ${address} (${why})`, () => {
      expect(classifyIp(address).allowed).toBe(false);
    });
  }

  const blockedV6: Array<[string, string]> = [
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fc00::1", "unique local"],
    ["fd12:3456::1", "unique local"],
    ["fe80::1", "link-local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["100::1", "discard"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["::ffff:10.0.0.1", "IPv4-mapped private"],
    ["64:ff9b::127.0.0.1", "NAT64 loopback"],
    ["64:ff9b::169.254.169.254", "NAT64 metadata"],
  ];

  for (const [address, why] of blockedV6) {
    test(`blocks ${address} (${why})`, () => {
      expect(classifyIp(address).allowed).toBe(false);
    });
  }

  test("unwrapping matters — a mapped address must not skip the v4 blocklist", () => {
    // ::ffff:127.0.0.1 is loopback wearing an IPv6 costume.
    expect(classifyIp("::ffff:127.0.0.1").reason).toContain("loopback");
  });

  test("allows ordinary public addresses", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1::1"]) {
      expect(classifyIp(address).allowed).toBe(true);
    }
  });

  test("blocks anything unparseable rather than passing it through", () => {
    for (const value of ["", "not-an-ip", "999.999.999.999", "javascript:alert(1)"]) {
      expect(classifyIp(value).allowed).toBe(false);
    }
  });

  test("reports the address family", () => {
    expect(classifyIp("8.8.8.8").version).toBe(4);
    expect(classifyIp("2606:2800:220:1::1").version).toBe(6);
  });
});

describe("hostnameVerdict", () => {
  test("blocks localhost and internal suffixes", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "printer.local",
      "db.internal",
      "metadata.google.internal",
      "wiki.intranet",
      "router.home.arpa",
    ]) {
      expect(hostnameVerdict(host).allowed).toBe(false);
    }
  });

  test("blocks an IP literal by classifying it", () => {
    expect(hostnameVerdict("127.0.0.1").allowed).toBe(false);
    expect(hostnameVerdict("169.254.169.254").allowed).toBe(false);
  });

  test("allows a public hostname before DNS decides", () => {
    expect(hostnameVerdict("images.example.com").allowed).toBe(true);
    expect(hostnameVerdict("cdn.example.com.").allowed).toBe(true);
  });

  test("does not confuse a suffix with a substring", () => {
    // "notlocal.example.com" ends with neither ".local" nor "localhost".
    expect(hostnameVerdict("notlocal.example.com").allowed).toBe(true);
    expect(hostnameVerdict("mylocalhost.example.com").allowed).toBe(true);
  });

  test("rejects an empty hostname", () => {
    expect(hostnameVerdict("").allowed).toBe(false);
  });
});

describe("isIpLiteral", () => {
  test("recognizes both families", () => {
    expect(isIpLiteral("1.2.3.4")).toBe(true);
    expect(isIpLiteral("::1")).toBe(true);
    expect(isIpLiteral("example.com")).toBe(false);
  });
});
