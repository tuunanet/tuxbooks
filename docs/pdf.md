# PDF layer

`src-tauri/src/pdf/` is a metadata-only PDF reader built on `lopdf` (pure
Rust, no rendering engine). Like `epub/`, it has no Tauri or SQLx imports
and returns owned data. The stated reason for the dependency: the scanner
must index real-world PDF libraries (title/author/subject) without pulling
in a renderer — page rendering belongs to the frontend engine (see
"Rendering" below).

## Public API

```rust
pub fn parse_pdf(path: &Path) -> Result<PdfBook, PdfError>;

pub struct PdfBook {
    pub metadata: PdfMetadata,
}

pub struct PdfMetadata {
    pub title: String,              // /Title, or file-name fallback
    pub author: Option<String>,     // /Author
    pub description: Option<String> // /Subject (PDFs have no description field)
}
```

## Behavior

1. **Open** — `lopdf::Document::load`; structural failures (not a PDF,
   unrecoverable xref, unsupported encryption) are `PdfError::Parse`.
2. **Info dictionary** — resolved through the trailer (`/Info` may be an
   indirect reference). A missing Info dictionary is not an error.
3. **Strings** — UTF-16BE (with `FE FF` byte-order mark) and
   PDFDocEncoding/Latin-1 are both decoded, trimmed, never lossy-panicking.
4. **Title fallback** — a missing/empty `/Title` indexes the book under a
   humanized file name (underscores become spaces); titles are mandatory in
   the library schema.

## Import mapping

| PDF field  | Library column                                                       |
| ---------- | -------------------------------------------------------------------- |
| `/Title`   | `title` (file-name fallback)                                         |
| `/Author`  | `author`                                                             |
| `/Subject` | `description`                                                        |
| —          | `publisher`, `language`, `isbn` stay NULL                            |
| —          | `cover_path` stays NULL (no rendering; the UI shows placeholder art) |

## Error handling

Per-file failures never abort an import run: the importer collects them in
`ImportReport.failed` exactly like EPUB parse failures.

## Rendering

Rendering is the frontend's job: `pdfjs-dist` (PDF.js) rasterizes pages to a
canvas in the webview, with parsing off the UI thread in a bundled worker
(`frontend/src/lib/pdf/pdfEngine.ts` is the only module that touches
PDF.js). Rust controls byte access: the `get_book_bytes` command resolves a
book id to its stored path through the database (`services::reader`) and
answers with an IPC raw byte response, so paths never cross the boundary and
multi-megabyte files avoid JSON encoding.

### Continuous reader architecture (`frontend/src/components/reader/pdf/`)

- `PdfReader.tsx` — composition root: zoom state, the initialization
  sequence (document ready → layout ready → position restored →
  interactive), and the render-set derivation.
- `hooks/usePdfDocument` — loads bytes via `get_book_bytes`; owns the
  document lifetime (destroy on unmount/book switch).
- `hooks/usePdfGeometry` — reserves the whole document from a page-1
  estimate, then corrects pages lazily as they approach visibility
  (`measurePages`; corrections are idempotent per document).
- `hooks/usePdfVirtualization` — an IntersectionObserver pair over the slot
  elements (visible: no margin; preload: ±1 viewport height) feeds the
  visible/preload page sets.
- `hooks/usePdfScrollTracking` — rAF-coalesced scroll sampling. Current
  page = the page containing the reading anchor (viewport top + 25% of the
  viewport height); also records the anchor's in-page fraction.
- `hooks/useFitWidthScale` — layout scale = fit-width base (reference page
  1 vs. content area) × zoom multiplier (50–200%; keyboard +/= and -).
  Wider pages in mixed documents overflow horizontally.
- `hooks/usePdfPersistence` — debounced save + restore-once (below).
- `pdfLayout.ts` — pure layout math (slot stacking, page lookup at an
  offset, clamping, scroll compensation, fit-width scale); unit-tested
  without a browser.
- `PdfDocumentView` / `PdfPageSlot` / `PdfPageCanvas` / `PdfToolbar` — one
  geometry slot per page for the entire document; canvases only for the
  bounded render set. Slots carry `data-pdf-slot` + `data-render-state`
  lifecycle attributes (`unloaded|queued|loading|rendering|rendered|error`)
  for tests and diagnostics.

### Virtualization and rendering policy

Modeled on the official viewer's `PDFRenderingQueue` (the PDF.js worker
rasterizes serially, so concurrent `render()` calls just queue FIFO and the
read page can starve behind invisible work):

1. Exactly one render runs at a time.
2. Priority: reading anchor page, then visible pages (closest first).
3. Exactly one prerender page beyond the viewport — and only while nothing
   visible needs rendering.
4. A superseded render is unmounted (cancelled); it never starts or blits.
5. Completed canvases stay mounted while their page stays inside the
   virtualization window (≤ 8, `MAX_ACTIVE_CANVASES`); distant pages keep
   geometry-only slots and report `data-render-state="unloaded"`.

Every render paints into a private offscreen buffer; the visible canvas is
touched only by the atomic blit of a completed render (single-writer —
interleaved paint loops on shared canvas state produced mirrored page
fragments under fast scrollbar drags on WebKitGTK). Page render failures
show a per-slot error with Retry; a page failure never breaks the document.

### Reading position persistence

`save_reading_progress` / `get_reading_progress` commands store
`reading_progress` rows (migration `0003` added `page_number` and
`scroll_offset`). For PDFs the page number is the stable position;
`progress_percent` feeds the shell footer. The reader restores exactly once
after the layout is ready — invalid values degrade to page 1 — saves are
debounced (1s) so scrolling never writes per event, the first armed run is
skipped so opening a book writes nothing, and unmount flushes the final
position. The document surface renders only after restoration, so reopening
never flashes page 1 before the jump.

### Worker

The worker is bundled via a Vite `?url` import and configured once in the
engine. A silent "fake worker" fallback (main-thread rendering) is the
classic cause of seconds-long variable renders — the reader exposes
`data-pdf-worker-src` and the seeded E2E verifies the asset is fetchable.

Still out of scope: thumbnails, annotations, text search, and outlines.
