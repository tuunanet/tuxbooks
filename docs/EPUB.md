# EPUB layer

The EPUB subsystem has two halves: a small Rust parser used at import time
(`sidecar/src/epub/`) and the rendering engine used by the reader
(Readium TS Toolkit, in the renderer).

## Rust import parser

`sidecar/src/epub/` is a small, dependency-light EPUB reader: `zip` +
`quick-xml` only. It has no runtime (Tauri/Electron) or SQLx imports and
returns owned data, so parsed values are cheap to move between threads and
layers.

## Public API

```rust
pub fn parse_epub(path: &Path) -> Result<EpubBook, EpubError>;

pub struct EpubBook {
    pub metadata: EpubMetadata, // title, author(+authors), subjects, language,
                                // publisher, isbn, description, publication_date,
                                // series(+series_index from calibre metas)
    pub spine: Vec<String>,     // manifest hrefs in reading order
    pub cover: Option<CoverImage>, // media_type + raw bytes
}
```

## Parsing stages

1. **Container validation** — first ZIP entry must be `mimetype` with
   exactly `application/epub+zip` (strict, no trimming).
2. **META-INF/container.xml** — first `<rootfile full-path=...>` is the
   OPF location; missing container or rootfile are typed errors.
3. **OPF (package document)** — single streaming pass collects:
   - `<dc:title/creator/subject/date/language/publisher/description>`
     (namespace prefix agnostic, entities unescaped); every `dc:creator`
     and `dc:subject` is kept — the first creator doubles as the flat
     `author` display value
   - `<dc:identifier opf:scheme="ISBN">` for the ISBN
   - `<meta name="cover" content="id">` (EPUB2 legacy cover)
   - `<meta name="calibre:series" content="...">` and
     `<meta name="calibre:series_index" content="n">` (index parse is
     tolerant: a comma decimal separator works, a non-numeric value is
     simply dropped)
   - `<item id, href, media-type, properties>` manifest
   - `<itemref idref>` spine
4. **Reading order** — spine idrefs resolved through the manifest;
   unknown idref → `EpubError::BrokenSpine`.
5. **Cover** — EPUB3 `properties~="cover-image"` preferred, EPUB2
   `<meta name="cover">` fallback; bytes resolved relative to the OPF
   directory (handles `../`, `./`, and `%XX` escapes).

## Error handling

`EpubError` is an exhaustive enum (`MissingMimetype`, `InvalidMimetype`,
`MissingContainer`, `NoRootfile`, `MissingOpf`, `OpfXml`, `MissingTitle`,
`BrokenSpine`, `ManifestItemWithoutHref`, `Zip`, `Io`). Parsers never
panic on malformed input — a property test feeds arbitrary bytes through
`parse_epub`.

## Known limitations (intentional, for now)

- Rust parser: no page list, encryption.xml (DRM), or media-overlay
  support; contents extraction is metadata/spine/cover only.
- Fixed-layout EPUBs render through Readium's fixed-layout support;
  reflowable books are the product priority.

## Reader rendering (Readium TS Toolkit)

The reader renders EPUBs with the **Readium TypeScript toolkit**
(`@readium/shared`, `@readium/navigator` et al.). Readium owns publication
parsing, resource loading, navigator state, pagination/scrolling, locators,
selection, and navigation; React owns only the surrounding UI. Verify the
current package layout and navigator APIs from npm + the official docs at
implementation time — no stale examples.

### Resource loading

EPUB resources load through the scoped `tuxbooks://` custom protocol
(range requests supported), answered by the Rust sidecar's `reader`
service via the Electron main process. No arbitrary local HTTP server;
paths never reach the renderer.

### Engine seam

`frontend/src/lib/epub/readiumEngine.ts` is the single module that imports
Readium packages (successor of the old foliate `epubEngine.ts`). Everything
else depends on its types and the seam's handle:

- `open(resourceBase)` opens the publication over `tuxbooks://`.
- navigator attachment, pagination/scroll mode, appearance injection
  (user stylesheet over publisher styles — font size, serif/sans override,
  line spacing, theme colors). The UI font size is a percent of the
  publication's default reading size (Readium reading-system scale: 100% =
  native, 75%–400% in `EPUB_FONT_SIZE_SCALE_PERCENT`, 100% reset); the seam
  converts it to Readium's unitless ratio (`lib/epub/appearance.ts`,
  percent ÷ 100) — the toolkit silently drops values outside its accepted
  `[0.7, 4]` range. Publication-relative only: the EPUB reader font size is
  never modeled as px and stays separate from PDF zoom.
- `onRelocate` delivers the current locator + progression + TOC context;
  external links are intercepted, never navigated.

Components: `EpubReader.tsx` owns lifecycle (DOCUMENT_READY →
POSITION_RESTORED → INTERACTIVE) and the shared
`components/reader/useReaderProgress` hook owns position save/restore (the
same debounced contract the PDF reader uses).

### Position locator

Readium locators (EPUB CFI + progression) are the canonical persisted
form. See "Progress migration" below for how existing foliate-era rows
convert; never reset or destructively rewrite progress rows.

### Progress migration (foliate → Readium)

Stored progress is user data. The migration adapter
(`frontend/src/lib/epub/progressMigration.ts`) converts existing foliate
rows (`cfi` + `chapter_href` + `progress_percent`, migration `0004`) into
Readium locators, validated against the actual EPUB:

- versioned + idempotent; original data preserved until validated;
  per-book completion marker.
- Fallback hierarchy: exact location → CFI → spine+element/offset →
  spine+progression → book percentage → beginning (never silently jump to
  the beginning when a better fallback exists).
- Preserve the **logical** reading position, not the old visual page
  number; Readium recomputes pagination.
- Fixtures (required test data): mid-chapter, chapter boundaries, last-read,
  varied spine structures, large chapters, reflowable + fixed-layout,
  malformed/stale locators, missing EPUBs, older-version records.

### Shell integration invariants (unified reader model)

- `EpubReader` registers the shell's `ReaderAdapter` (`readerModel.ts`)
  while its navigator is open: `jump` (TOC hrefs and bookmark/search
  locators share the seam's locator grammar), the shared
  `ReaderSearchController`, and the shared `ReaderAnnotationController`.
  ReaderShell drives all three without format branches; the adapter is
  nulled on unmount/book switch so a stale engine can never be driven.
- The reader reports its position as the tagged `ReaderPosition`
  (`{ format: "epub", locator, chapterHref }`) through `onPositionChange`;
  that tagged value is what bookmark placement persists.
- Arrow/space/PageUp/PageDown are owned exclusively by the EPUB engine
  while an EPUB is open: the shell must not register its
  percentage-stepping/scrolling handlers for EPUB (null-combo gating in
  ReaderShell) — with no page count a shell step is 100/0 and the provider
  clamp sends the position straight to an end of the document.

### In-book search

Search runs through the seam over the publication, streaming per-section
results (`{ label, subitems: [{ locator, excerpt }] }`). The UI side is
format-agnostic: `ReaderShell` owns the shared `ReaderSearchState`
(`components/reader/searchModel.ts`) and `ReaderSearchTab` renders query,
match count, per-section groups, and excerpts; picking a match calls
`goTo(locator)`. A new search supersedes the running one by generation.

### Annotations

Highlights live in the engine's overlay layer, behind the seam: add/remove
highlight by locator, re-applied when the engine mounts a section. Highlights
queued while no navigator exists yet (stored ones, before `init` finishes
loading) are applied by `init` as soon as the navigator is up — a reopened
book paints its stored highlights without any interaction. Creation runs
through real text selections (the selection's canonical
locator is requested from the engine; the pending selection is kept as a
cloned `Range`, never pixels). Bookmarks persist the current relocate
locator. The shared selection toolbar creates highlights only — EPUB
selections never target an existing highlight, so recolor and removal stay
in the navigation drawer.

### Security

EPUB content may contain scripts. Sections render in sandboxed iframes;
the Electron session enforces a restrictive CSP (`script-src 'self'`, no
remote content), and external links are intercepted, never navigated.
The renderer has no Node.js access (`contextIsolation: true`,
`nodeIntegration: false`, sandboxed preload).

### Testability contract

Stable DOM attributes on the engine host (`data-epub-state`,
`data-epub-section`, `data-epub-section-total`, `data-epub-fraction`,
`data-epub-highlights` — the number of stored highlights currently applied
as decorations) — keep them when refactoring; E2E asserts on them rather
than engine-internal DOM.

## Fixtures

Parser behavior is pinned by `tests/fixtures/books/minimal.epub`
(regenerate with `python3 scripts/make-fixture.py`; content is original,
license-free) and by the dedicated corpus in `tests/fixtures/epub/core/` —
30 tiny EPUB 2 + EPUB 3 fixtures (minimal, navigation, content, styling,
links, images, i18n, malformed) regenerated with `just make-epub-fixtures`
and validated by `just check-epub-fixtures`. See
[the corpus README](../tests/fixtures/epub/README.md). Tests live in
`epub/mod.rs`, `epub/metadata.rs`, `epub/parser.rs`, and
`sidecar/tests/epub_corpus.rs`, plus the progress-migration fixtures
described above.
