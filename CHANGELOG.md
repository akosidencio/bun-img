# Changelog

## [0.1.1] — 2026-09-03

- Fixed `imageUrl()` and `srcset()` producing unusable URLs for remote sources —
  they now emit the query form, which absolute `http(s)` URLs survive.
- Added `identify()` to the remote resolver: a warm cache is served after a
  `HEAD` instead of a full download. Opt out with `remote: { identify: false }`.
- Presigned URLs no longer churn the cache — AWS SigV4, GCS, CloudFront and
  Azure SAS signatures are stripped from the source identity. Other query
  parameters are kept, since they may select content.
- Remote identity is keyed on the requested URL, not the redirect target.
- Exported `canonicalSourceUrl`.

Upgrading: remote cache keys changed, so cached remote entries are recomputed
once. Origins will now see `HEAD` requests. No API or config changes.

## [0.1.0] — 2026-08-28

- Initial release. Sharp-free image optimization and delivery for Bun: JPEG, PNG
  and WebP, resize, orientation, blur placeholders, two-tier cache, bounded
  concurrency, SSRF-hardened remote sources, and `next/image` + `astro:assets`
  adapters.

[0.1.1]: https://github.com/akosidencio/bun-img/releases/tag/v0.1.1
[0.1.0]: https://github.com/akosidencio/bun-img/releases/tag/v0.1.0
