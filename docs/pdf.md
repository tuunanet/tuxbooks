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

| PDF field  | Library column                                                     |
| ---------- | ------------------------------------------------------------------ |
| `/Title`   | `title` (file-name fallback)                                       |
| `/Author`  | `author`                                                           |
| `/Subject` | `description`                                                      |
| —          | `publisher`, `language`, `isbn` stay NULL                          |
| page 1     | `cover_path` (rasterized to PNG by `pdf/render.rs` at import; NULL |
|            | when the PDFium library is unavailable — placeholder art then)     |

## Error handling

Per-file failures never abort an import run: the importer collects them in
`ImportReport.failed` exactly like EPUB parse failures.

## Rendering

Rendering is the frontend's job: `pdfjs-dist` (PDF.js) rasterizes pages to a
canvas in the webview, with parsing off the UI thread in a bundled worker
(`frontend/src/lib/pdf/pdfEngine.ts` is the only module that touches
PDF.js, and loads the library lazily on first document open so PDF.js stays
out of the entry chunk). Rust controls byte access: the `get_book_bytes`
command resolves a book id to its stored path through the database
(`services::reader`) and answers with an IPC raw byte response, so paths
never cross the boundary and multi-megabyte files avoid JSON encoding.

### Continuous reader architecture (`frontend/src/components/reader/pdf/`)

- `PdfReader.tsx` — composition root: zoom state, the initialization
  sequence (document ready → layout ready → position restored →
  interactive), and the render-set derivation.
- `hooks/usePdfDocument` — loads bytes via `get_book_bytes`; owns the
  document lifetime (destroy on unmount/book switch). A switch also drops
  the previous document from state in that render (render-phase reset), so
  a closed document never serves a render while the next loads, and a load
  that lands after its book was superseded is destroyed, never mounted.
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
  offset, clamping, scroll compensation, fit-width scale, thumbnail
  geometry); unit-tested without a browser.
- `pdfOutline.ts` — pure outline normalization: the engine's raw outline
  (named or explicit destinations, external-link entries) resolves to a
  tree of `{ title, page (1-based | null), items }`; unresolvable entries
  degrade to inert rows, never errors. Re-exported through the engine seam
  as `getPdfOutline` so components never touch the engine's raw types.
- `PdfDocumentView` / `PdfPageSlot` / `PdfPageCanvas` / `PdfToolbar` — one
  geometry slot per page for the entire document; canvases only for the
  bounded render set. Slots carry `data-pdf-slot` + `data-render-state`
  lifecycle attributes (`unloaded|queued|loading|rendering|rendered|error`)
  for tests and diagnostics.
- `PdfSidebar` — the thumbnails panel (below). Rendered through a React
  portal into a host `<aside>` owned by ReaderShell's layout: the shell
  docks the host beside the scroll container, while PdfReader keeps single
  ownership of the document handle the thumbnails render from.

### Virtualization and rendering policy

Modeled on the official viewer's `PDFRenderingQueue`, adjusted for what
PDF.js v6 actually parallelizes (verified against `mozilla/pdf.js` source):
each page's operator list is produced independently in the worker, and each
render's paint loop is a time-sliced task on the main thread — so a small
number of concurrent renders pipeline (page N paints while page N+1 parses
and decodes) instead of page N+1 waiting behind N's entire raster. Only
same-canvas concurrency is forbidden by the engine (`InternalRenderTask`
tracks canvases in use), and the reader's private-buffer-per-render design
never shares one.

1. Up to `MAX_CONCURRENT_RENDERS` (2) renders run at a time; completions
   and cancellations free their slot for the next priority page. The
   reading anchor starts first, then visible pages (closest first).
2. Exactly one prerender page beyond the viewport — and only while the
   concurrency budget has room to spare.
3. A superseded render is unmounted (cancelled); it never starts or blits.
4. Completed canvases stay mounted while their page stays inside the
   virtualization window (≤ 8, `MAX_ACTIVE_CANVASES`); distant pages keep
   geometry-only slots and report `data-render-state="unloaded"`. The
   rendered/failed page sets reset with the document, so a switched book
   can never inherit the previous book's render marks.
5. On eviction the finished bitmap moves into a per-document LRU cache
   (`pdfBitmapCache`, bounded by byte budget and entry count, keyed by
   render scale, dropped on zoom and on document switch). A page that
   re-enters the window blits its retained bitmap in one synchronous draw —
   scrolling back across a heavy page never re-pays the raster. Cache
   occupancy is exposed for diagnostics as `data-pdf-bitmap-cache`
   (`entries:bytes`) on the reader element.

Every render paints into a private offscreen buffer; the visible canvas is
touched only by the atomic blit of a completed render (single-writer —
interleaved paint loops on shared canvas state produced mirrored page
fragments under fast scrollbar drags on WebKitGTK). Page render failures
show a per-slot error with Retry; a page failure never breaks the document.

### Thumbnails sidebar (`PdfSidebar`)

The same virtualization policy at low resolution. The sidebar reuses the
slot/observer pattern: one cell per page reserves space up front (aspect
from the shared page sizes, corrected lazily via the same `measurePages`
path), and an observer pair feeds a render set capped at
`MAX_THUMBNAIL_CANVASES` (12) with exactly one render in flight — the
worker rasterizes serially, so unbounded thumbnail requests would starve
the page the user is looking at. Canvases render at the cell width
(`THUMBNAIL_WIDTH_PX`, 112), mount only inside the window, and evict with
it, so memory stays bounded on any document. The reading page's cell is
marked (`data-thumb-active` / `aria-current`) and follows the position
whether it moves by scrolling, navigation, or restore; clicking a cell
navigates the reader (and suppresses the one follow-up auto-scroll).
Failed thumbnails flag their cell and re-attempt when the cell re-enters
the window — no per-cell retry buttons.

### Outline

The document outline comes from the engine seam (`getPdfOutline`) — the
PDF.js document is already parsed in the webview, so the outline shares the
engine with rendering instead of growing a second parser in Rust. Every
destination resolves to the same 1-based page locator the reader persists;
PdfReader reports the normalized tree upward and ReaderNavigation's Outline
tab renders it with depth indentation (loading / empty / inert-row states
included). Outline navigation reuses `pageToPosition`, so jumping lands in
the same position model as scrolling, thumbnails, and restore.

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

Still out of scope: annotations and text search.
