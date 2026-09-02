# Conformance fixtures (Tier C)

External standards corpora — the W3C EPUB test suite and similar large
compatibility datasets. Treated as an external test dataset, not application
source: **nothing here is committed to Git**, and the normal PR test suite
never downloads it.

## W3C EPUB tests (candidate, not yet pinned)

- Source repository: https://github.com/w3c/epub-tests
- Status: **candidate only**. No version is pinned yet because pinning
  requires the real values below (commit, archive checksum, license
  verification, retrieval date) — never invented placeholders.
- Relevant subset for TuxBooks: package-document handling (EPUB 2 + EPUB 3
  OPFs), navigation (NCX + nav), and content-document parsing. The suite
  also contains tests for features TuxBooks does not implement (media
  overlays, scripting, fixed layout) — when a corpus version is pinned,
  document the included/excluded subsets here.

## How it will work

The same machinery as the extended tier applies:

```sh
just fetch-epub-extended     # verifies checksums, caches under .build/fixtures/epub/
just test-epub-conformance   # opt-in run through the real parser
```

A future `[[dataset]]` entry in `tests/fixtures/epub/fixtures.toml` pins:

- `id` / `version` — corpus identity (the cache key includes both);
- `source` — one versioned archive (a repo snapshot archive URL), not
  hundreds of individual files;
- `license` — the corpus license, verified before pinning;
- `archive_sha256` — checksum of the exact archive;
- `retrieved` — date the checksum was captured.

CI note: if this ever runs in GitHub Actions, wrap it in an actions cache
keyed on `id + version + archive_sha256` so the corpus is downloaded once,
not per build (see `docs/testing.md`). The default CI path must never
download it.
