# PDF layer

`src-tauri/src/pdf/` is a metadata-only PDF reader built on `lopdf` (pure
Rust, no rendering engine). Like `epub/`, it has no runtime (Tauri/Electron)
or SQLx imports and returns owned data. The stated reason for the
dependency: the scanner must index real-world PDF libraries
(title/author/subject) without pulling in a renderer — page rendering
belongs to the frontend engine (see "Rendering" below).

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

Cover rasterization stays in Rust (PDFium) unless MuPDF in the renderer
provably replaces it at import quality/latency; re-evaluate at migration
phase 4 and record the decision here.

## Error handling

Per-file failures never abort an import run: the importer collects them in
`ImportReport.failed` exactly like EPUB parse failures.

## Rendering

Rendering is the renderer's job: **MuPDF.js/WASM** rasterizes pages to
canvas, with expensive work off the UI thread in the MuPDF worker. Verify
the current npm distribution and worker API at implementation time — no
stale package-layout assumptions. `frontend/src/lib/pdf/pdfEngine.ts` is
the only module that touches MuPDF, loaded lazily on first document open so
the WASM bundle stays out of the entry chunk. Byte access flows through the
`tuxbooks://` custom protocol (range requests supported) — paths never
cross the boundary.

### Continuous reader architecture (`frontend/src/components/reader/pdf/`)

- `PdfReader.tsx` — composition root: zoom state, the initialization
  sequence (document ready → layout ready → position restored →
  interactive), and the render-set derivation.
- `hooks/usePdfDocument` — loads bytes via the bridge/protocol; owns the
  document lifetime (destroy on unmount/book switch). A switch also drops
  the previous document from state in that render (render-phase reset), so
  a closed document never serves a render while the next loads, and a load
  that lands after its book was superseded is destroyed, never mounted.
- `hooks/usePdfGeometry` — reserves the whole document from a page-1
  estimate, then corrects pages lazily as they approach visibility
  (`measurePages`; corrections are idempotent per document).
- `hooks/usePdfVirtualization` — an IntersectionObserver pair over the slot
  elements (visible: no margin; preload: a fixed ±1200 px ≈ one 1080p
  viewport, bounded at any window size) feeds the visible/preload page sets.
- `hooks/usePdfScrollTracking` — rAF-coalesced scroll sampling. Current
  page = the page containing the reading anchor (viewport top + 25% of the
  viewport height); also records the anchor's in-page fraction.
- `hooks/useFitWidthScale` — layout scale = fit-width base (reference page
  1 vs. content area) × zoom multiplier (50–200%; keyboard +/= and -).
  Wider pages in mixed documents overflow horizontally.
- shared `components/reader/useReaderProgress` — debounced save +
  restore-once (below); one persistence core for both formats, with PDF
  page validation in `readerModel.parsePdfProgress`.
- `pdfLayout.ts` — pure layout math (slot stacking, page lookup at an
  offset, clamping, scroll compensation, fit-width scale, thumbnail
  geometry); unit-tested without a browser.
- `pdfRenderPolicy.ts` — pure render-budget math: the effective render
  ratio per page (devicePixelRatio capped by the backing-store budgets, CSS
  upscales beyond) and the byte cap over the live render window.
- `pdfOutline.ts` — pure outline normalization: the engine's raw outline
  resolves to a tree of `{ title, page (1-based | null), items }`;
  unresolvable entries degrade to inert rows, never errors. Re-exported
  through the engine seam so components never touch the engine's raw types.
- `PdfDocumentView` / `PdfPageSlot` / `PdfPageCanvas` / `PdfToolbar` — one
  geometry slot per page for the entire document; canvases only for the
  bounded render set. Slots carry `data-pdf-slot` + `data-render-state`
  lifecycle attributes (`unloaded|queued|loading|rendering|rendered|error`)
  for tests and diagnostics.
- `PdfSidebar` — the thumbnails panel (below). Rendered through a React
  portal into a host `<aside>` owned by ReaderShell's layout.

### Virtualization and rendering policy

Never render a large PDF into the DOM at once; keep rasterization off the
critical path.

1. Up to `MAX_CONCURRENT_RENDERS` (2) renders run at a time; completions
   and cancellations free their slot for the next priority page. The
   reading anchor starts first, then visible pages (closest first).
2. Exactly one prerender page beyond the viewport — and only while the
   concurrency budget has room to spare.
3. A superseded render is unmounted (cancelled); it never starts or blits.
4. Completed canvases stay mounted while their page stays inside the
   virtualization window, bounded first by a byte budget
   (256 MB, `MAX_ACTIVE_CANVAS_BYTES`) and then by the count fallback
   (`MAX_ACTIVE_CANVASES`, 8): at 4K only the closest few page-sized
   buffers fit, at smaller windows the byte budget is inert. Distant pages
   keep geometry-only slots and report `data-render-state="unloaded"`. The
   rendered/failed page sets reset with the document, so a switched book
   can never inherit the previous book's render marks.
5. Each page rasterizes into an offscreen buffer at the effective render
   ratio (`pdfRenderPolicy.effectiveRenderRatio`), a two-tier ladder:
   devicePixelRatio preferred, degrading to the soft budget, then to CSS
   resolution (never blurrier than the layout while the hard budget
   allows), and only under zoom into the hard per-dimension budget; the
   canvas CSS size stays at the displayed size and CSS upscales beyond the
   ratio.
6. On eviction the finished bitmap moves into a per-document LRU cache
   (`pdfBitmapCache`, bounded by a 320 MB byte budget and entry count,
   keyed by render scale and effective ratio, dropped on zoom and on
   document switch). A page that re-enters the window blits its retained
   bitmap in one synchronous draw — scrolling back across a heavy page
   never re-pays the raster. Cache occupancy is exposed for diagnostics as
   `data-pdf-bitmap-cache` (`entries:bytes`) on the reader element.

Every render paints into a private offscreen buffer; the visible canvas is
touched only by the atomic blit of a completed render (single-writer —
interleaved paint on shared canvas state produced mirrored page fragments
under fast scrollbar drags). Page render failures show a per-slot error
with Retry; a page failure never breaks the document.

This pipeline is budgeted in pixels and bytes (canvas caps, cache
occupancy, live-canvas memory) — the contracts and their verification live
in `docs/performance.md`. Check them before changing rendering,
virtualization, or cache policy. Startup diagnostics (PERF-11) are
deterministic attributes on the reader element (`data-pdf-render-info`:
dpr, content width, viewport height, fit scale; `data-pdf-render-ms` on
each canvas: the last render→blit durations).

### Thumbnails sidebar (`PdfSidebar`)

The same virtualization policy at low resolution. The sidebar reuses the
slot/observer pattern: one cell per page reserves space up front (aspect
from the shared page sizes, corrected lazily via the same `measurePages`
path), and an observer pair feeds a render set capped at
`MAX_THUMBNAIL_CANVASES` (12) with exactly one render in flight — unbounded
thumbnail requests would starve the page the user is looking at. Canvases
render at the cell width (`THUMBNAIL_WIDTH_PX`, 112), mount only inside the
window, and evict with it, so memory stays bounded on any document. The
reading page's cell is marked (`data-thumb-active` / `aria-current`) and
follows the position whether it moves by scrolling, navigation, or restore;
clicking a cell navigates the reader (and suppresses the one follow-up
auto-scroll). Failed thumbnails flag their cell and re-attempt when the
cell re-enters the window — no per-cell retry buttons.

### Outline

The document outline comes from the engine seam (`getPdfOutline`) — the
MuPDF document is already parsed in the renderer, so the outline shares the
engine with rendering instead of growing a second parser in Rust. Every
destination resolves to the same 1-based page locator the reader persists;
PdfReader reports the normalized tree upward and ReaderNavigation's Outline
tab renders it with depth indentation. Outline navigation reuses
`pageToPosition`, so jumping lands in the same position model as scrolling,
thumbnails, and restore.

### Reading position persistence

`save_reading_progress` / `get_reading_progress` methods store
`reading_progress` rows (migration `0003` added `page_number` and
`scroll_offset`). For PDFs the page number is the stable position;
`progress_percent` feeds the shell footer. The reader restores exactly once
after the layout is ready — invalid values degrade to page 1 — saves are
debounced (1s) so scrolling never writes per event, the first armed run is
skipped so opening a book writes nothing, and unmount flushes the final
position. The document surface renders only after restoration, so reopening
never flashes page 1 before the jump. This contract lives in one shared
hook (`useReaderProgress`) used by both readers; the PDF reader also
registers the shell's `ReaderAdapter` (`readerModel.ts`) while its document
is loaded — `jump` maps page targets through the same `pageToPosition`
model as scrolling, thumbnails, outline, and restore — and reports
`{ format: "pdf", page, fraction }` positions upward for bookmark
placement.

### In-book search

Search reuses the engine that already renders the document instead of
growing a second extraction architecture: the seam pulls a page's text
content through MuPDF and assembles it with the pure helpers in
`lib/pdf/pdfSearch.ts` (item and line boundaries become single spaces, so
queries match across them like they read on the page).

`components/reader/pdf/hooks/usePdfSearch.ts` walks pages sequentially
(worker-serialized), matches case-insensitively, streams one group per page
with matches up to the shell, and stops at 500 total matches so a
pathological document cannot flood the drawer. Each page's text is cached
for the document's lifetime (dropped on document switch), so refining a
query re-searches without re-parsing; a generation token makes a new query
supersede the running one.

The drawer's Search tab is the shared `ReaderSearchTab`; PDF matches carry
`page` (EPUB matches carry a locator — see `searchModel.ts`). Picking a
match navigates with the same `pageToPosition` model as scrolling,
thumbnails, outline, and restore.

### Text layer, selection, and highlights

Rendered pages mount a text layer (`PdfPageTextLayer`, through the seam)
over the canvas: transparent, selectable text spans — the interaction
affordance for highlights, no visuals of its own. The layer's stylesheet
(`lib/pdf/pdfTextLayer.css`) is engine-coupled: pin it to the bundled
MuPDF.js version and re-extract on upgrade. Text layers exist only on the
bounded render set, like canvases.

Text selections are captured on `pointerup` (deferred one tick): the
anchor node resolves the page through the slot's `data-pdf-slot`, the
selected text and the range's client rects normalize to page space
(`normalizeRect`, clamped to 0..1 so the backend's geometry validation
accepts sub-pixel bleed), and the whole candidate — page, text, rects — is
stored at capture time. This matters: clicking the selection toolbar's
color swatch collapses the native selection before the click handler runs,
so creation must not re-read the live selection (the reader's `pointerup`
capture also ignores events originating inside the toolbar).

Persisted highlights render through `PdfHighlightOverlay`: absolutely
positioned translucent rects in normalized page space, so they track the
canvas at every zoom without recomputation, drawn for the open book's
annotation list (grouped by page in PdfReader, rendered inside the page
wrapper). Bookmarks persist the anchor page + in-page fraction reported by
the scroll tracker — a coarse page-local position, per the data model.

### Worker

The MuPDF worker is bundled and configured once in the engine. A
main-thread fallback is the classic cause of seconds-long variable renders
— the reader exposes `data-pdf-worker-src` and the seeded E2E verifies the
asset is fetchable.
