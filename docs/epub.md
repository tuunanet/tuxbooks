# EPUB layer

The EPUB subsystem has two halves: a small Rust parser used at import time
(`src-tauri/src/epub/`) and a browser-side rendering engine used by the
reader (`frontend/src/lib/epub/`).

## Rust import parser

`src-tauri/src/epub/` is a small, dependency-light EPUB reader: `zip`

- `quick-xml` only. It has no Tauri or SQLx imports and returns owned
  data, so parsed values are cheap to move between threads and layers.

## Public API

```rust
pub fn parse_epub(path: &Path) -> Result<EpubBook, EpubError>;

pub struct EpubBook {
    pub metadata: EpubMetadata, // title, author, language, publisher, isbn, description
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
   - `<dc:title/creator/language/publisher/description>` (namespace
     prefix agnostic, entities unescaped)
   - `<dc:identifier opf:scheme="ISBN">` for the ISBN
   - `<meta name="cover" content="id">` (EPUB2 legacy cover)
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
  support; contents extraction is metadata/spine/cover only (the reader
  engine parses document structure itself from the file bytes).
- Fixed-layout EPUBs use the engine's fixed-layout renderer, the least
  mature part of foliate-js; reflowable books are the product priority.

## Reader rendering (frontend, foliate-js)

The reader renders EPUBs with **foliate-js** (MIT), vendored as a git
submodule pinned at `frontend/src/lib/epub/foliate-js`. It was chosen over
epub.js (npm-frozen since 2022-02) and the Readium TS toolkit (heavier,
manifest-oriented) because it is proven on this exact stack — Foliate uses
it on WebKitGTK and Readest ships it inside Tauri v2 — and it has zero hard
dependencies.

The submodule pins **upstream** `johnfactotum/foliate-js`. The Readest
fork was evaluated and rejected: its multi-view paginator rework hangs or
mis-paginates real-world EPUB 2 books (e.g. Manning titles with large
`.html` sections), while upstream paginates them correctly. One WebKit
quirk is handled at the seam instead: WebKit resolves `fonts.ready` early
while section fonts are still settling, so the paginator's deferred
re-expand can measure a zero-size document and collapse the section iframe
to zero width (blank reader). `EpubReader` therefore schedules one
`EpubViewHandle.relayout()` per section once fonts settle, which re-runs
the paginator layout with real geometry. It is consumed only through the
engine seam.

### Vendored submodule

A fresh clone needs `git submodule update --init` (pnpm install does not
fetch the submodule). Never edit files inside it: it is excluded from lint
and typechecked only through the stub `frontend/src/lib/epub/foliate-js.d.ts`.
`frontend/vite.config.ts` stubs out `foliate-js/pdf.js` (Vite-incompatible;
PDF rendering belongs to pdfEngine).

### Engine seam

`frontend/src/lib/epub/epubEngine.ts` is the single module that imports the
vendored sources (mirroring `lib/pdf/pdfEngine.ts` for PDF.js). Everything
else depends on its types and on `EpubViewHandle`:

- `open(bytes)` parses the EPUB from raw IPC bytes (`get_book_bytes`) in a
  Blob; zip access happens inside the engine via its vendored zip.js.
- `init(lastLocation)` restores a CFI or starts at the book's beginning.
- `onRelocate` delivers `{ cfi, fraction, section, tocItem }`;
  `onLoad` delivers each mounted section document; `onExternalLink`
  intercepts (and blocks) outbound links.
- `setFlow("paginated" | "scrolled")` maps the reader layout preference
  onto the renderer's `flow` attribute.
- `setAppearance(css)` injects the user stylesheet (`epubAppearanceCss`:
  font size, optional serif/sans override, line spacing, theme colors) into
  every section document, user-`!important` over publisher styles.

Components: `EpubReader.tsx` owns lifecycle (DOCUMENT_READY →
POSITION_RESTORED → INTERACTIVE), `epub/hooks/useEpubDocument` owns the
engine lifetime (a book switch drops the previous handle and detaches its
host in that render; a superseded open is closed, never mounted),
`epub/hooks/useEpubPersistence` owns position save/restore (same debounced
contract as the PDF reader).

### Position locator

Progress is format-specific (see migration `0004_reading_progress_cfi`):
EPUB persists `cfi` (canonical EPUB CFI — resource + location together),
`chapter_href` (spine href of the current section), and `progress_percent`
(coarse shell position used for bookmarks/progress UI). Restore validates
the stored CFI (`epubcfi(` prefix) and degrades to the book start when
missing or malformed.

### Shell integration invariants

- Arrow/space/PageUp/PageDown are owned exclusively by the EPUB engine
  while an EPUB is open: the shell must not register its
  percentage-stepping/scrolling handlers for EPUB (null-combo gating in
  ReaderShell) — with no page count a shell step is 100/0 and the provider
  clamp sends the position straight to an end of the document.
- The engine does not report byte sizes, so shell progress is derived from
  spine position (`section` + in-section page fraction); outside
  percent-jumps map onto spine indexes — the CFI stays the exact locator.

### In-book search (milestone 5)

Search runs entirely in the engine through the seam:
`EpubViewHandle.search(query, callbacks)` drives the vendored
`search.js` matcher over every spine section and streams results per
chapter (`onSection` → `{ label, subitems: [{ cfi, excerpt }] }`, with
`excerpt = { pre, match, post }`) plus `onDone`. The engine's overlayer
draws every match into the rendered pages until the next search or
`clearSearch()`. A new search supersedes the running one by generation:
the old iteration is stopped (`AsyncGenerator.return`) and its callbacks
never fire again.

The UI side is format-agnostic: `EpubReader` registers a
`ReaderSearchController` on the shell's `searchTargetRef`; `ReaderShell`
owns the shared `ReaderSearchState` (`components/reader/searchModel.ts`)
and the navigation drawer's Search tab (`ReaderSearchTab`) renders query,
match count, per-chapter groups, and excerpts. Picking a match calls
`goTo(cfi)` — the exact locator EPUB persistence already uses — and the
drawer stays open for the next hit. The toolbar Search button and
Ctrl/Cmd+F open the drawer straight onto the Search tab. Chapter labels
come from the engine's TOC progress; label-less chapters fall back to
"Chapter N".

### Annotations (milestone 6)

Highlights live in the engine's overlay layer, behind the same seam. The
seam wraps the vendored `Overlayer`: `EpubViewHandle.addHighlight(cfi,
color)` draws (or queues per spine index) a translucent highlight, and the
handle's `create-overlay` subscription re-adds a section's highlights
whenever the engine mounts that section's overlay; the paginator redraws
on reflow. `removeHighlight` and the add/remove diff in `EpubReader` keep
the engine in step with the persisted annotation list.

Creation runs through real text selections: each section document gets a
`pointerup` capture (deferred one tick), the selection's text is reported
to the shell's shared `SelectionToolbar`, and picking a color asks the
engine for the canonical locator via `getCfiFromRange` — the engine's own
`getCFI(index, range)` over the mounted section — then persists a
highlight through the annotations commands. The pending selection is kept
as a cloned `Range`, never pixels, so creation does not depend on the
native selection surviving the toolbar click. Bookmarks persist the
current relocate CFI (+ spine href), reported upward through
`onLocatorChange`.

### Security

EPUB content may contain scripts; foliate-js renders sections in
same-origin `blob:` iframe documents, and WebKit's iframe `sandbox` is
useless (bug 218086) — so scripting is blocked by the application CSP in
`tauri.conf.json`: `script-src 'self'` (blob: documents inherit it),
`frame-src 'self' blob:` so the section iframes may load at all, and
`blob:` allowed for `img-src`/`style-src`/`font-src`/`media-src` so book
resources load. External links are intercepted, never navigated.

### Testability contract

Stable DOM attributes on the engine host (`data-epub-state`,
`data-epub-section`, `data-epub-section-total`, `data-epub-fraction`,
`data-epub-doc-math-count`) — keep them when refactoring; E2E asserts on
them because the engine's shadow root and iframes are closed to WebDriver.
MathML (EPUB 3) renders natively through WebKit's MathML Core; the fixture
book carries a `mathml`-properties chapter to pin that end to end.

## Fixtures

Parser behavior is pinned by `tests/fixtures/books/minimal.epub`
(regenerate with `python3 scripts/make-fixture.py`; content is original,
license-free) and by the dedicated corpus in `tests/fixtures/epub/core/` —
30 tiny EPUB 2 + EPUB 3 fixtures (minimal, navigation, content, styling,
links, images, i18n, malformed) regenerated with `just make-epub-fixtures`
and validated by `just check-epub-fixtures`. See
[the corpus README](../tests/fixtures/epub/README.md). Tests live in
`epub/mod.rs`, `epub/metadata.rs`, `epub/parser.rs`, and
`src-tauri/tests/epub_corpus.rs`.

## Planned evolution

The engine seam is the swap point: if foliate-js ever blocks a product
need, `@readium/navigator` (ts-toolkit) is the evaluated fallback, and only
`epubEngine.ts` + `EpubReader` would change. Media overlays and TTS modules
exist in the vendored engine for later milestones (`search.js` and the
annotation overlayer are already in use behind the seam).
