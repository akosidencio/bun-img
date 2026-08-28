import { describe, expect, test } from "bun:test";
import {
  matchHostname,
  matchPathname,
  matchesAnyPattern,
  matchesPattern,
  type RemotePattern,
} from "../../src/sources/patterns.ts";

const url = (s: string) => new URL(s);

describe("matchHostname", () => {
  test("matches exactly, case-insensitively", () => {
    expect(matchHostname("cdn.example.com", "cdn.example.com")).toBe(true);
    expect(matchHostname("CDN.example.com", "cdn.EXAMPLE.com")).toBe(true);
    expect(matchHostname("cdn.example.com", "other.example.com")).toBe(false);
  });

  test("tolerates a trailing dot on either side", () => {
    expect(matchHostname("cdn.example.com.", "cdn.example.com")).toBe(true);
    expect(matchHostname("cdn.example.com", "cdn.example.com.")).toBe(true);
  });

  test("wildcard matches subdomains", () => {
    expect(matchHostname("*.example.com", "cdn.example.com")).toBe(true);
    expect(matchHostname("*.example.com", "a.b.example.com")).toBe(true);
  });

  test("wildcard does NOT match the bare apex", () => {
    // Granting *.cdn.example.com should not implicitly grant example.com, which
    // usually hosts something entirely different.
    expect(matchHostname("*.example.com", "example.com")).toBe(false);
  });

  test("wildcard does not match a lookalike suffix", () => {
    expect(matchHostname("*.example.com", "notexample.com")).toBe(false);
    expect(matchHostname("*.example.com", "evil-example.com")).toBe(false);
    expect(matchHostname("*.example.com", "example.com.evil.net")).toBe(false);
  });
});

describe("matchPathname", () => {
  test("matches literals", () => {
    expect(matchPathname("/a.png", "/a.png")).toBe(true);
    expect(matchPathname("/a.png", "/b.png")).toBe(false);
  });

  test("single star stays inside one segment", () => {
    expect(matchPathname("/img/*", "/img/a.png")).toBe(true);
    expect(matchPathname("/img/*", "/img/deep/a.png")).toBe(false);
  });

  test("double star crosses segments", () => {
    expect(matchPathname("/products/**", "/products/a.png")).toBe(true);
    expect(matchPathname("/products/**", "/products/2026/spring/a.png")).toBe(true);
    expect(matchPathname("/products/**", "/other/a.png")).toBe(false);
  });

  test("regex metacharacters in a pattern stay literal", () => {
    // A pattern must never become an accidentally permissive regex.
    expect(matchPathname("/a.png", "/aXpng")).toBe(false);
    expect(matchPathname("/a+b.png", "/a+b.png")).toBe(true);
    expect(matchPathname("/(a).png", "/(a).png")).toBe(true);
    expect(matchPathname("/a?.png", "/ab.png")).toBe(false);
  });

  test("is anchored at both ends", () => {
    expect(matchPathname("/img/*", "/prefix/img/a.png")).toBe(false);
    expect(matchPathname("/img/*", "/img/a.png/suffix")).toBe(false);
  });
});

describe("matchesPattern", () => {
  test("defaults to https", () => {
    const p: RemotePattern = { hostname: "cdn.example.com" };
    expect(matchesPattern(p, url("https://cdn.example.com/a.png"))).toBe(true);
    expect(matchesPattern(p, url("http://cdn.example.com/a.png"))).toBe(false);
  });

  test("http must be opted into", () => {
    const p: RemotePattern = { protocol: "http", hostname: "cdn.example.com" };
    expect(matchesPattern(p, url("http://cdn.example.com/a.png"))).toBe(true);
    expect(matchesPattern(p, url("https://cdn.example.com/a.png"))).toBe(false);
  });

  test("without an explicit port, only the protocol default is allowed", () => {
    // An allowlisted host on :8080 may be something entirely different.
    const p: RemotePattern = { hostname: "cdn.example.com" };
    expect(matchesPattern(p, url("https://cdn.example.com/a.png"))).toBe(true);
    expect(matchesPattern(p, url("https://cdn.example.com:8443/a.png"))).toBe(false);
  });

  test("an explicit port must match exactly", () => {
    const p: RemotePattern = { hostname: "cdn.example.com", port: "8443" };
    expect(matchesPattern(p, url("https://cdn.example.com:8443/a.png"))).toBe(true);
    expect(matchesPattern(p, url("https://cdn.example.com/a.png"))).toBe(false);
  });

  test("path constraint applies when present", () => {
    const p: RemotePattern = { hostname: "cdn.example.com", pathname: "/products/**" };
    expect(matchesPattern(p, url("https://cdn.example.com/products/a.png"))).toBe(true);
    expect(matchesPattern(p, url("https://cdn.example.com/secrets/a.png"))).toBe(false);
  });

  test("an omitted path allows any path", () => {
    const p: RemotePattern = { hostname: "cdn.example.com" };
    expect(matchesPattern(p, url("https://cdn.example.com/anything/at/all.png"))).toBe(true);
  });
});

describe("matchesAnyPattern", () => {
  test("an empty list allows nothing", () => {
    // The default, and the right one: remote sources are off until configured.
    expect(matchesAnyPattern([], url("https://cdn.example.com/a.png"))).toBe(false);
  });

  test("any single match is enough", () => {
    const patterns: RemotePattern[] = [
      { hostname: "a.example.com" },
      { hostname: "b.example.com" },
    ];
    expect(matchesAnyPattern(patterns, url("https://b.example.com/x.png"))).toBe(true);
    expect(matchesAnyPattern(patterns, url("https://c.example.com/x.png"))).toBe(false);
  });
});
