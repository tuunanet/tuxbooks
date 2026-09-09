# Free ebook fixture corpus — research & implementation plan

Replaces the proprietary library in `tests/fixtures/books/EBooks` (gitignored,
copyrighted, ~510 MB) with a small, freely licensed corpus that a script
downloads on demand. Research done 2026-09-09 (Tavily; sources cited inline).

## Why not commit the files

The current `AGENTS.md` in the fixtures dir exists only to say "do not commit —
copyrighted". A downloaded corpus removes the problem entirely: everything is
freely licensed, nothing proprietary ever lands in the tree, and the repo stays
small (corpus fetched when needed, like `just fetch-pdfium`).

## Candidate corpora (researched)

### EPUB

| Source                                                                                                                                             | License                                                     | Notes                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [IDPF/epub3-samples](https://github.com/idpf/epub3-samples) (canonical list: [idpf.github.io/epub3-samples](https://idpf.github.io/epub3-samples)) | CC-BY-SA 3.0 unless noted (a few CC-BY-NC-SA — avoid those) | The industry-standard EPUB 3 sample set: `childrens-literature`, `epub30-spec`, `figure-gallery-bindings`, `page-blanche`, `accessibility` samples, etc. **Stable pinned download URLs** via GitHub releases, e.g. `https://github.com/IDPF/epub3-samples/releases/download/20230704/childrens-literature.epub` — ideal for hash-pinned manifests. |
| [Project Gutenberg](https://www.gutenberg.org)                                                                                                     | Public domain                                               | Direct one-step URLs (`https://www.gutenberg.org/ebooks/2701.epub3.images`). Good for a few "real novel-sized" EPUBs. Caveats: robots.txt blocks wget/curl default UAs (set a custom UA), mirrors may serve stale bytes, so **pin to mirror + verify hash** rather than trusting round-trip bytes.                                                 |
| [Standard Ebooks](https://standardebooks.org)                                                                                                      | Public domain (CC0 typesetting)                             | Beautifully produced EPUBs; downloads behind a small redirect chain — acceptable, but Gutenberg/IDPF are simpler to pin.                                                                                                                                                                                                                           |

### PDF

| Source                                                                        | License                                                       | Notes                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [py-pdf/sample-files](https://github.com/py-pdf/sample-files)                 | **CC-BY-SA-4.0 (every file)**                                 | Purpose-built "files which can be used to test PDF readers" — includes multipage, outlines, forms, encrypted-ish, scanned samples. Plain files in the repo → stable `raw.githubusercontent.com` URLs. |
| [arXiv](https://arxiv.org) PDFs                                               | Author-held / CC-BY variants; redistribution allowed for most | Real academic PDFs, stable direct URLs (`https://arxiv.org/pdf/<id>`). Matches the existing `Argxiv/` category being replaced. Choose CC-BY papers where the license page states it.                  |
| [pdf-association/pdf-corpora](https://github.com/pdf-association/pdf-corpora) | Mixed (index of corpora)                                      | Overkill for a library-app corpus; note as future reference only.                                                                                                                                     |

## Recommendation

- **EPUB (3–5 files):** IDPF/epub3-samples via pinned GitHub-release URLs.
- **PDF (3–5 files):** py-pdf/sample-files, plus 1–2 arXiv CC-BY papers.
- Skip Gutenberg/Standard Ebooks for v1 (URL/hash stability is weaker); keep as
  documented alternatives if more novel-length content is needed.

## Implementation plan

### 1. Manifest: `tests/fixtures/books/EBooks/manifest.json`

Committed (the one exception to the gitignore — see step 5). Single source of
truth, following the pattern of `make-epub-fixtures.py`'s checksum manifest:

```json
{
  "version": 1,
  "books": [
    {
      "file": "EPUB Samples/childrens-literature.epub",
      "url": "https://github.com/IDPF/epub3-samples/releases/download/20230704/childrens-literature.epub",
      "sha256": "…",
      "sizeBytes": 1234567,
      "license": "CC-BY-SA 3.0",
      "source": "IDPF/epub3-samples"
    }
  ]
}
```

- `sha256` + `sizeBytes` are both verified: hash proves bytes, size allows a
  cheap pre-check/skip.
- Relative `file` paths recreate the category layout the tests know
  (`realistic_library.rs` walks recursively; `bench-reader` looks under
  `Agents/` — see step 6).

### 2. Script: `scripts/fetch-ebook-fixtures.py`

Python 3 stdlib only (`urllib.request`, `hashlib`, `json`, `concurrent.futures`)
— matches `scripts/make-fixture.py` / `make-epub-fixtures.py` conventions.

- `--check` — verify mode, no network: fail with a per-file diff report if any
  manifest entry is missing, wrong size, or wrong hash. Also warns about
  unexpected `*.{epub,pdf}` files not in the manifest.
- Default — fill mode: download only missing/invalid files (idempotent,
  resumable), stream to a temp file, verify sha256 **before** renaming into
  place (no partially-downloaded file can ever be imported by tests), then
  write a `.state/fetched-ok` marker or simply rely on re-`--check`.
- `--prune` — remove non-manifest ebook files (used when shrinking the corpus).
- Custom `User-Agent` header (required by gutenberg.org robots policy; harmless
  elsewhere).
- Exit code 1 on any verification failure → usable in `just check`-style gates.

### 3. Justfile recipes

```just
# Download the free ebook fixture corpus (tests/fixtures/books/EBooks)
fetch-ebooks:
    python3 scripts/fetch-ebook-fixtures.py

# Verify the corpus matches the manifest (no download)
check-ebooks:
    python3 scripts/fetch-ebook-fixtures.py --check
```

Do **not** add `fetch-ebooks` to `just check`/`just test` (network + 50 MB
corpus); mirror the `fetch-pdfium` model: explicit recipe, documented in
`docs/testing.md`. Tests that need the corpus already skip gracefully when
absent (`realistic_library.rs:45`), so a fresh clone without downloads stays
green.

### 4. Corpus selection (initial set)

Keep total under ~60 MB. Concretely:

- `EPUB Samples/`: childrens-literature, page-blanche, figure-gallery-bindings,
  epub30-spec (IDPF; skip CC-BY-NC-SA items like cc-shared-culture).
- `PDF Samples/`: 2–3 py-pdf/sample-files readers-oriented PDFs.
- `Papers/`: 1–2 arXiv CC-BY PDFs (replacement for the old `Argxiv/` files).

### 5. Gitignore & fixture hygiene

- `.gitignore` already ignores `tests/fixtures/books/EBooks/`; narrow it to
  ignore everything **except** `manifest.json`:
  `tests/fixtures/books/EBooks/*` + `!tests/fixtures/books/EBooks/manifest.json`.
- Replace the dir's `AGENTS.md` ("do not commit") with a pointer to this doc.

### 6. Test/doc updates

- `docs/testing.md` — "Test data rules" section: swap the "real user-created
  library" paragraph for the free-corpus description + `just fetch-ebooks`.
- `sidecar/tests/realistic_library.rs` — doc comment only (path-based logic and
  skip behavior are unchanged). `bench-reader.e2e.ts` seeds from `Agents/`;
  either keep a dir name it expects or update the seed path — check
  `e2e/` seeding code when picking final directory names.
- `graphify update .` after code changes (repo convention).

### 7. Verification mechanism (summary)

1. **sha256 pinning** — every file's expected hash in the committed manifest.
2. **Post-download verification** — script hashes each download before it
   becomes visible at its final path.
3. **Standalone gate** — `just check-ebooks` (offline `--check`) fails with
   per-file detail; suitable for CI or a pre-e2e sanity step.
4. **Drift detection** — `--check` also flags stray files, so the corpus can't
   silently accrete untracked books again.

### Open items

- Fill exact sha256 values by downloading the chosen files once and running
  `sha256sum` (script supports a `--emit-hash <file>` helper to make this easy).
- Confirm e2e seeded-phase path expectations (`E2E_SEED_LIBRARY=1`) against the
  new directory layout.
