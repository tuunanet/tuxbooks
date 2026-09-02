# EPUB fixture corpus

Three tiers. The dividing rule: **small synthetic fixtures belong in Git;
large publications do not belong in the normal committed fixture corpus.**
The default test suite (`just test`, `just check`, normal CI) must always be
able to run from a clean checkout with **zero fixture downloads**.

| Tier            | What                                         | Where                               | Committing            | Downloaded by default tests |
| --------------- | -------------------------------------------- | ----------------------------------- | --------------------- | --------------------------- |
| A — core        | Tiny deterministic EPUB 2 + EPUB 3 fixtures  | `core/` (this directory)            | Yes                   | Never (in Git)              |
| B — extended    | Large real-world books                       | `.build/fixtures/epub/extended/`    | No (external, cached) | Never (opt-in only)         |
| C — conformance | W3C EPUB tests and similar standards corpora | `.build/fixtures/epub/conformance/` | No (external, cached) | Never (opt-in only)         |

There is deliberately **no Git LFS** and no large committed corpus: every
clone stays small, CI checkout stays fast, and no test run needs the network
before it can start. Large fixtures are versioned external datasets fetched
on demand (see `extended/` and `conformance/`).

## Layout

```text
core/
  epub2/    minimal, navigation, content, styling, links, images, i18n (.epub)
  epub2/malformed/   intentionally broken publications (generated mutations)
  epub3/    same coverage set for EPUB 3
sources/
  epub2/<name>/    human-readable source trees (generated, committed)
  epub3/<name>/
extended/         README only — Tier B datasets never live here
conformance/      README only — Tier C datasets never live here
fixtures.toml     generated manifest: checksums, versions, sizes, licenses
```

## Generation and validation

```sh
just make-epub-fixtures    # regenerate sources/, core/, fixtures.toml
just check-epub-fixtures   # validate (also a `just check` stream + CI step)
```

Everything is authored in `scripts/make-epub-fixtures.py` (original content,
same philosophy as `scripts/make-fixture.py` for the PDF fixtures). The
script writes the readable source trees, assembles the `.epub` artifacts, and
emits the manifest; `--check` regenerates into a temp dir and byte-compares.

Determinism contract — running generation twice produces identical bytes:

- fixed ZIP metadata (timestamps, entry ordering, permissions,
  `create_system`), `mimetype` first and STORED, the rest DEFLATED;
- fixed unique identifiers (no random UUIDs), no clock or machine paths;
- malformed fixtures are deterministic mutations of the minimal publication,
  each recorded in `fixtures.toml` with an `expected_failure`.

`--check` (and therefore `just check` / CI) fails when any of these drift:
regeneration mismatch, checksum/size drift vs the manifest, an EPUB that does
not identify as its generation, a malformed fixture without its marker, or a
size-budget violation:

```text
Large fixture detected. Move this test to the extended/conformance corpus
rather than committing it to the core fixture set.
```

Current budget (see `[limits]` in `fixtures.toml`; the corpus runs far below
it): 100 KB per fixture, 512 KB total, 50 KB per source asset.

## Parser-facing contract

`src-tauri/tests/epub_corpus.rs` runs on every `cargo test`: every valid
core fixture parses (non-empty title + spine), every malformed fixture is
rejected, and the corpus stays small. EPUB 2 fixtures use NCX + XHTML 1.1 +
the legacy `<meta name="cover">` convention; EPUB 3 fixtures use nav (+ NCX
fallback where noted), XHTML5 semantics, `cover-image` properties, and basic
i18n (RTL, CJK, ruby, vertical writing).

## Licensing

All core fixtures are TuxBooks-authored original content with no third-party
material; the repository license (GPLv3) applies. Every `[[fixture]]` entry
in `fixtures.toml` records this. Third-party material must never be
committed here — it belongs in the extended/conformance tiers with full
provenance (source URL, exact version, license, archive checksum, retrieval
date), and only after its redistribution terms are verified.
