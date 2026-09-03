# Changelog

Notable changes to `bun-img`. Dates are release dates; the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
semver, with the 0.x caveat that the leading zero is where the instability
lives.

## [0.1.1] — 2026-09-03

Remote sources worked, but were awkward to reach and expensive to serve. All
three problems here are about HTTP(S) sources; local sources are unaffected.

### Fixed

- **`imageUrl()` and `srcset()` produced unusable URLs for remote sources.** The
  operation-path form encodes the source as path segments, and a URL's `//` does
  not survive that — `https://bucket.s3…/cat.png` came back as
  `https:/bucket.s3…/cat.png`, which no resolver claims, so the request failed
  with `403 SOURCE_NOT_ALLOWED`. Both builders now switch to the query form for
  absolute `http(s)` sources. `srcset` was affected on every candidate.
  `bun-img/next`'s loader already did this and is unchanged.

### Added

- **`identify()` on the remote resolver.** A warm cache is now served after a
  `HEAD` instead of a full download. Previously a cache *hit* still re-fetched
  the entire body from the origin and saved only the encode; on a page of 20
  remote images that was 20 full downloads per view. Measured on a 74 KB source
  over four requests: one `GET` and four `HEAD`s, down from four `GET`s — 74 KB
  transferred instead of 294 KB.
- **`remote: { identify: false }`** to opt out, for an origin that mishandles
  `HEAD` or images small enough that the round trip costs more than the bytes.
  An origin that answers `HEAD` without an `ETag` or `Last-Modified`, or refuses
  it outright, opts itself out automatically rather than breaking.
- **`canonicalSourceUrl`** is exported from the package entry.

### Changed

- **Presigned URLs no longer churn the cache.** The signature was part of the
  source identity, so a URL reissued every 15 minutes produced a new cache key
  every time and nothing ever hit. AWS SigV4, GCS V4, CloudFront and Azure SAS
  parameters are now stripped from the identity.

  Stripping is deliberately narrow: each scheme is gated on a marker parameter
  that ordinary URLs do not carry, and only that scheme's own parameters are
  removed. Everything else — `?v=2`, `?page=3` — stays part of the identity,
  because dropping a parameter that *selects content* would collapse two
  different images onto one cache entry and serve the wrong bytes.

- **Remote identity is keyed on the URL as requested, not the redirect target.**
  `identify()` cannot know the target without following it, and an identity that
  disagreed with `resolve()`'s would file cache entries under a key the fast path
  then failed to find. Consequence: two distinct URLs that redirect to the same
  object no longer share a cache entry.

- The engine only establishes identity up front when a result cache is
  configured. With no cache there is nothing to answer from, so the `HEAD` would
  buy nothing.

### Migration

- **Cached remote entries are orphaned.** Remote cache keys changed, so existing
  entries for remote sources will not be found and will be recomputed on first
  request. Local sources are unaffected. Nothing needs clearing — orphans age
  out under the normal LRU — but clear the disk cache if you would rather not
  carry them.
- **Expect `HEAD` requests to your image origins.** If an origin bills per
  request, or its logs assume `GET` only, set `remote: { identify: false }`.
- No API removals, and no configuration changes are required.

## [0.1.0] — 2026-08-28

Initial release. Sharp-free image optimization and delivery for Bun, built on
`Bun.Image`: JPEG, PNG and WebP encode, resize, orientation, native blur
placeholders, a two-tier cache, bounded concurrency with load shedding,
SSRF-hardened remote sources, path-traversal-safe local sources, and adapters
for `next/image` and `astro:assets`.

[0.1.1]: https://github.com/akosidencio/bun-img/releases/tag/v0.1.1
[0.1.0]: https://github.com/akosidencio/bun-img/releases/tag/v0.1.0
