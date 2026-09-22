# PDF layer

`sidecar/src/pdf/` is a metadata-only PDF reader built on `lopdf` (pure
Rust, no rendering engine). Like `epub/`, it has no runtime (Tauri/Electron)
or SQLx imports and returns owned data. The stated reason for the
dependency: the scanner must index real-world PDF libraries
(title/author/subject) without pulling in a renderer — page rendering
belongs to the frontend engine (see "Rendering" below).

## Public API

```rust
pub fn parse_pdf(path: &Path) -> Result<PdfBook, PdfError>;
pub fn read_file_properties(path: &Path) -> Result<Vec<(String, String)>, PdfError>;

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

## File properties (read-only)

`read_file_properties(path)` returns every non-empty document information
dictionary entry in a stable order — Title, Author, Subject, Keywords,
Creator, Producer, Creation date, Modification date — for the book detail
view's "Original File Metadata" panel. Unlike `parse_pdf` there is no
file-name title fallback: the panel reports what the file actually carries.
PDF date strings (`D:YYYYMMDD…`) are rendered as `YYYY-MM-DD HH:mm`.

## Import mapping

| PDF field  | Library column                                                     |
| ---------- | ------------------------------------------------------------------ |
| `/Title`   | `title` (file-name fallback)                                       |
| `/Author`  | `author`                                                           |
| `/Subject` | `description`                                                      |
| —          | `publisher`, `language`, `isbn` stay NULL                          |
| page 1     | `cover_path` (rasterized to PNG by `pdf/render.rs` at import; NULL |
|            | when the PDFium library is unavailable — placeholder art then)     |

Cover rasterization stays in Rust (PDFium). Decision recorded at migration
phase 4: the renderer engine does not replace it — the renderer rasterizes
whole documents for the reading surface, while import-time covers need a
per-file, no-UI rasterization in the sidecar; keeping native PDFium avoids
loading every full document during a scan for identical quality.

## Metadata writing (embed)

`write_metadata(path, &PdfMetadata)` supports the metadata dialog's explicit
"Embed into file" action: it sets `/Title`, `/Author`, and `/Subject` in the
document information dictionary (creating one when absent and preserving every
other Info entry), saves through `lopdf`, and swaps the file atomically.
Non-ASCII values are written as UTF-16BE hex strings with a byte-order mark —
the same forms the reader decodes. Publisher, language, ISBN, publication
date, series, and subtitle have no faithful PDF Info field and stay
database-side as overrides (the embed flow reports them as still overridden).
Library subjects are not written to `/Keywords` — that mapping is a deliberate
follow-up, so `/Keywords` stays a read-only file property for now. A one-time
`<file>.bak` copy of the original is made before the first write
(later embeds keep it), so the pre-embed file is always recoverable.

## Error handling

Per-file failures never abort an import run: the importer collects them in
`ImportReport.failed` exactly like EPUB parse failures.

## Rendering

Rendering is the renderer's job: **PDFium compiled to WebAssembly**
(`@embedpdf/pdfium`) rasterizes pages, with all engine objects and
rasterization in a dedicated module worker (`lib/pdf/pdfiumWorker.ts`) —
PDFium's C API is synchronous, so the worker keeps it off the UI thread.
One worker instance serves one document; closing the document terminates
the worker and frees the whole WASM heap. The engine lives behind a
three-layer seam: `frontend/src/lib/pdf/pdfEngine.ts` is the public seam
the reader imports, `pdfiumEngine.ts` is the main-thread adapter, and
`pdfiumCore.ts` is the only module that imports the engine package, so a
reader component can never depend on engine internals. The WASM bundle is
emitted by a small Vite plugin (`virtual:pdfium-wasm-url` in
`vite.config.ts`) because the engine glue's own chunk-relative resolution
never finds the asset in a bundled build; the main thread resolves the URL
and passes it into the open request. Byte access flows through the
`tuxbooks://` custom protocol (range requests supported) — paths never
cross the boundary.

### Opening (range-backed, never whole-file)

Documents open through **`FPDF_LoadCustomDocument` with
`FPDF_FILEACCESS`** (`openPdfDocumentFromBook`): the worker wraps
`tuxbooks://book/<id>` in a `PdfRangeSource` whose `m_GetBlock` reads are
synchronous XHR **HTTP Range requests** (legal only inside a worker) against
the Electron protocol handler, which seeks/reads through the Rust sidecar.
PDFium therefore pulls only the ranges it needs — the xref trail first, page
1 content next — and the first readable page no longer waits for the whole
file to cross the bridge. A 1 MiB read-ahead chunk cache (bounded, LRU)
keeps PDFium's scattered object reads from becoming one request per object.
The in-memory `openPdfDocument(bytes)` path remains for tests and byte
sources that are already fully resident.

### Engine prewarm

`prewarmPdfEngine()` loads the PDFium module into a spare worker (no
document, no rasterization) once the app shell has rendered and the main
thread is idle (`AppShell`'s `PdfEnginePrewarm`); the first open adopts
that warm worker instead of paying worker startup + WASM fetch/compile on
the critical path. It is single-flight, disabled without a Worker
environment, and a failed prewarm only means the next open starts cold.

### Continuous reader architecture (`frontend/src/components/reader/pdf/`)

- `PdfReader.tsx` — composition root: zoom state, the initialization
  sequence (document ready → layout ready → position restored →
  interactive), and the render-set derivation.
- `hooks/usePdfDocument` — opens the book through the range-backed engine
  seam (`openPdfDocumentFromBook`); owns the document lifetime (destroy on
  unmount/book switch). A switch also drops
  the previous document from state in that render (render-phase reset), so
  a closed document never serves a render while the next loads, and a load
  that lands after its book was superseded is destroyed, never mounted.
  Records the open-timeline anchor + `open=` segment for the telemetry
  attributes below.
- `hooks/usePdfGeometry` — reserves the whole document from a page-1
  estimate, then corrects pages lazily as they approach visibility
  (`measurePages`; corrections are idempotent per document).
- `hooks/usePdfVirtualization` — an IntersectionObserver pair over the slot
  elements (visible: no margin; preload: a fixed ±1200 px ≈ one 1080p
  viewport, bounded at any window size) feeds the visible/preload page sets.
- `hooks/usePdfScrollTracking` — rAF-coalesced scroll sampling. Current
  page = the page containing the reading anchor (viewport top + 25% of the
  viewport height); also records the anchor's in-page fraction.
- `hooks/usePdfScale` — layout scale from the zoom state (issue #65): the
  fit modes recompute continuously from the measured content area and the
  shell's scroll container (ResizeObserver pair + window resize), custom
  mode is a fixed scale. Pure scale selection lives in
  `pdfLayout.computePdfScale`; unmeasurable dimensions fall back to 1.
- shared `components/reader/useReaderProgress` — debounced save +
  restore-once (below); one persistence core for both formats, with PDF
  page validation in `readerModel.parsePdfProgress`.
- `pdfLayout.ts` — pure layout math (slot stacking, page lookup at an
  offset, clamping, scroll compensation, fit-width scale, thumbnail
  geometry); unit-tested without a browser.
- `pdfRenderPolicy.ts` — pure render-budget math: the effective render
  ratio per page (devicePixelRatio capped by the backing-store budgets, CSS
  upscales beyond), the byte cap over the live render window, and the
  deep-zoom region switch (`needsRegionRender`/`regionRenderRatio`).
- `pdfOutline.ts` — pure outline normalization: the engine's raw outline
  resolves to a tree of `{ title, page (1-based | null), items }`;
  unresolvable entries degrade to inert rows, never errors. Re-exported
  through the engine seam so components never touch the engine's raw types.
- `PdfDocumentView` / `PdfPageSlot` / `PdfPageCanvas` — one geometry slot
  per page for the entire document; canvases only for the bounded render
  set. Slots carry `data-pdf-slot` + `data-render-state` lifecycle
  attributes (`unloaded|queued|loading|rendering|rendered|error`) for tests
  and diagnostics. Above the whole-page budget, a canvas rasterizes only the
  page's visible region at device resolution (`usePdfViewport` +
  `visiblePageRegion`, the `pdfiumWorker` clip) and positions itself in the
  slot, so text stays sharp and no page-sized buffer is allocated; the
  canvas carries `data-pdf-render-region` (`full` or the region rect).
- `PdfToolbar` — the document controls (page navigation `‹ Page X of Y ›`;
  the Okular-style zoom combo — `−`, an editable percent input, a presets
  dropdown (Fit Width / Fit Page / Auto Fit plus `ZOOM_PRESETS`), `+` — and
  the presentation-mode toggle — issue #65), docked through a portal into a
  header slot owned by ReaderShell — the same pattern as PdfSidebar, with
  an inline fallback when no host is provided (standalone renders, e.g.
  unit tests). The toolbar carries `data-pdf-zoom-mode` (the active mode)
  for tests and diagnostics. Native `title` tooltips instead of Radix
  Tooltip: the toolbar also renders standalone, where no TooltipProvider
  exists. No control row renders above the document, so its vertical space
  goes to the pages; the reader keeps owning the zoom and position state.
- `PdfPresentationBar` — the floating in-presentation controls (prev/next,
  page indicator, exit), fixed to the bottom edge of the document while
  the shell's chrome is hidden (issue #65).
- `PdfSidebar` — the thumbnails panel (below). Rendered through a React
  portal into a host `<aside>` owned by ReaderShell's layout.

### Zoom modes (issue #65)

The zoom state is `{ mode, level }` — never a bare multiplier:

- **Fit width** (default; Ctrl+2) — document-wide scale from the page-1
  reference vs. the content area. Wider pages in mixed documents overflow
  horizontally instead of shrinking the fit reference.
- **Fit page** (Ctrl+1) — the binding axis wins (min of fit width/height).
- **Auto Fit** (Ctrl+3) — Papers' rule (`zoom_for_size_automatic`): fit the
  width, except for a landscape page (`height < width`) where the binding of
  the fit width and fit height scales wins (`autoFitScale`).
- **Custom** — any typed or preset percentage. The editable input shows the
  effective scale; typing a value (with or without `%`) and pressing Enter,
  or leaving the field, applies it, and an unparseable value reverts. The
  dropdown lists the presets in `ZOOM_PRESETS` (Okular's `kZoomValues`,
  12%–10000%) plus the three fit modes. Custom scales clamp to
  `[MIN_ZOOM, MAX_ZOOM]` (12%–10000%; 1 = 100%). Ctrl+0 resets to 100%.
  `Ctrl`+`+`/`-` (also bare `+`/`=`/`-`) snap the current effective scale
  onto the nearest preset and step from there, so leaving a fit mode
  continues from where the page actually is.

The fit modes are dynamic: the scale is recomputed from the measured
viewport whenever it changes (window resize, sidebar toggle), and the input
shows the effective page zoom (`scale × 100`). Any zoom or mode change
invalidates rendered canvases and the scale-keyed bitmap cache. `Ctrl` +
mouse wheel zooms (trackpad pinch arrives as the same ctrl-modified wheel in
Chromium): the deltas accumulate onto preset steps (`WHEEL_STEP_PX`, 40). A
scale change alone re-anchors by the reading anchor's in-page fraction; a
page change from navigation lands on the new page's top edge.

### Presentation mode (issue #65)

Ctrl+L (shell-owned toggle, shared with the EPUB mode — issue #64; also the
toolbar's Presentation button) turns the PDF reader into a fullscreen,
distraction-free one-page view:

- The shell hides the normal chrome (header, thumbnails sidebar), requests
  fullscreen best-effort (a denied request still gives
  the layout inside the normal window), and exits the mode on `Esc` and on
  a native fullscreen exit (`fullscreenchange`). The mode never outlives
  the open book.
- The reader switches to a **dynamic fit-page mode keyed to the page
  being read**: the page is scaled to fit inside the available area on both
  axes (contain), so mixed-size documents rescale as you flip and any page
  shape (portrait, landscape, or wide slides) stays fully visible. Only the
  selected page is laid out, centred in the viewport, so neighbours never
  show through. Entering preserves the current page; leaving restores the
  pre-presentation zoom state exactly.
- Page flips come from navigation rather than scrolling. `PageDown`/`Space`/
  `PageUp`/`Shift+Space`/arrows step whole pages (the shell's page-based
  steps, not percentage stepping, so rounding error cannot map a midpoint
  back onto the previous page) without touching zoom controls. The floating
  `PdfPresentationBar` mirrors prev/next/indicator and adds the exit
  control.
- The next and previous pages pre-render into the shared bitmap cache ahead
  of a flip. Only the current page is laid out, so the virtualization
  observers never see a neighbour and the render budget never admits one;
  without the preload every step rasterized from scratch behind a blank
  placeholder. Each neighbour rasterizes offscreen at its own page fit scale,
  one at a time, forward page first, once the current page is on screen (its
  size is measured first so the cache key matches on arrival). A flip then
  blits the retained bitmap instead of paying the raster, the same
  next/prev job model Papers uses (`pps-view-presentation.c`).

Shift participates in shortcut combos (`shift+space` vs `space`), so
selection-extension keys and Shift+Space never alias the unmodified
navigation combos.

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
   ratio. While the very first page of a freshly opened document is
   pending, the anchor page renders **two-stage** (`preview`): a readable
   preview at ratio ≤ 1 blits first and the full-ratio refinement replaces
   it in the background — the visible canvas only ever receives complete
   bitmaps (canvas carries `data-pdf-render-quality`
   `preview|final`).
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
in `docs/PERFORMANCE.md`. Check them before changing rendering,
virtualization, or cache policy. Startup diagnostics (PERF-11) are
deterministic attributes on the reader element (`data-pdf-render-info`:
dpr, content width, viewport height, fit scale; `data-pdf-render-ms` on
each canvas: the last render→blit durations).

### Open-timeline telemetry (state, not timing)

The reader publishes the PDF-open path as deterministic attributes on
every reader surface (error/loading/interactive), driven by the pure
helpers in `pdfOpenTelemetry.ts`:

- `data-pdf-open-state` —
  `created|document-opening|document-ready|geometry-ready|first-render-start|interactive`
  (a failed open reports `created` + the error surface);
- `data-pdf-open-timing` —
  `bytes=range;open=…;firstPaint=…;interactive=…`, segments omitted until
  measured (`open` = click→document parsed, `firstPaint` = click→first
  rendered page, `interactive` = the later of first paint and position
  restore);
- `data-pdf-open-ms`, `data-pdf-first-paint-ms`, `data-pdf-first-page` —
  the individual segments as bare numbers/page.

E2E asserts state values and attribute shape only; timing thresholds are
manual-bench material (`just bench-reader`, docs/PERFORMANCE.md), never
headless CI assertions. Outline work is explicitly ordered below first
paint: the outline request is sent only after the first page has rendered,
so it can never occupy the PDFium worker ahead of page 1.

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
PDFium document is already parsed in the renderer, so the outline shares the
engine with rendering instead of growing a second parser in Rust. The worker
walks PDFium's bookmarks (`FPDFBookmark_*`, `FPDFDest_GetDestPageIndex`) and
the pure normalizer maps destinations to pages. Every
destination resolves to the same 1-based page locator the reader persists;
PdfReader reports the normalized tree upward and ReaderNavigation's Outline
tab renders it with depth indentation. Outline navigation reuses
`pageToPosition`, so jumping lands in the same position model as scrolling,
thumbnails, and restore.

### Reading position persistence

`save_reading_progress` / `get_reading_progress` methods store
`reading_progress` rows (migration `0003` added `page_number` and
`scroll_offset`). For PDFs the page number is the stable position;
`progress_percent` still persists (the library grid/list cards read it), but
the PDF reader shows no footer — a fixed-layout page has no meaningful
percent-read. The shell exposes the tracked position as `data-reader-position`
for tests. The reader restores exactly once
after the layout is ready — invalid values degrade to page 1 — saves are
debounced (1s) so scrolling never writes per event, the first armed run is
skipped so opening a book writes nothing, and unmount flushes the final
position. Every persisted save (including `mark_book_finished`) emits
`library-changed` with the updated book, so the grid and list progress
bars stay live without an app restart. The document surface renders only
after restoration, so reopening
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
content through PDFium's text-page APIs and assembles it with the pure
helpers in `lib/pdf/pdfSearch.ts` (item and line boundaries become single
spaces, so queries match across them like they read on the page).

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
affordance for highlights, no visuals of its own. The seam builds the spans
from PDFium's structured-text lines (`FPDFText_*` character boxes grouped by
baseline); its stylesheet (`lib/pdf/pdfTextLayer.css`) is coupled to that
geometry. Text layers exist only on the bounded render set, like canvases.

Text selections are captured on `pointerup` (deferred one tick): the
anchor node resolves the page through the slot's `data-pdf-slot`, the
selected text and the range's client rects normalize to page space
(`normalizeRect`, clamped to 0..1 so the backend's geometry validation
accepts sub-pixel bleed), and the whole candidate — page, text, rects — is
stored at capture time. This matters: clicking the selection toolbar's
color swatch collapses the native selection before the click handler runs,
so creation must not re-read the live selection (the reader's `pointerup`
capture also ignores events originating inside the toolbar). The upward
report carries the existing highlight the selection targets, if any: the
same-page highlight with the largest rect overlap
(`highlightForSelection`), or the highlight under a plain click
(`highlightAtPoint`).

Persisted highlights render through `PdfHighlightOverlay`: absolutely
positioned translucent rects in normalized page space, so they track the
canvas at every zoom without recomputation, drawn for the open book's
annotation list (grouped by page in PdfReader, rendered inside the page
wrapper). The overlay stays pointer-transparent: a plain click resolves
through the selection handler instead of overlay events.

Existing highlights are edited from the same selection toolbar. When the
reported target has a highlight, the toolbar switches from creating to
editing — color swatches recolor the annotation (`update_annotation`), and
a distinct Remove action deletes it (`delete_annotation`, the same path as
the navigation drawer). Removal is a real deletion, never a transparent
recolor — a dead annotation would linger in state, search, and the
drawer. Bookmarks persist the anchor page + in-page fraction reported by
the scroll tracker — a coarse page-local position, per the data model.

### Worker

The PDFium worker is bundled and configured once in the engine. A
main-thread fallback is the classic cause of seconds-long variable renders
— the reader exposes `data-pdf-worker-src` and the seeded E2E verifies the
asset is fetchable. One worker serves one document, so render, text
extraction, outline, and thumbnail requests serialize inside it; the
open-path ordering (page 1 first, then adjacent pages, then outline and
thumbnails) is enforced on the main thread — see "Open-timeline
telemetry" above. A worker that dies unexpectedly rejects its pending
requests and fires a one-shot listener; the document owner re-opens once
from the range-backed source and a second death surfaces as a real error.
There is no worker recycling: PDFium has no JS-device state to corrupt.

### Diagnostics

The worker posts an out-of-band breadcrumb for every request it starts,
finishes, or fails (`{ kind: "pdf-worker-diag", … }`, no request id) that
carries the method, page, elapsed time, and the current WASM linear-memory
size; the engine logs the stream at debug level and keeps the last line.
A worker request in flight past `WORKER_STALL_WARN_MS` (10 s) is reported
by a main-thread watchdog while it is still running, so a blocked worker
(a synchronous range read, a large raster) leaves a trace instead of
looking like a frozen UI. The main process mirrors the renderer console
and replays its tail on `render-process-gone` (`electron/main/index.ts`),
because a renderer crash takes the whole console with it. The memory line
is a diagnostic; PDFium's C API takes no native object into a JS callback,
so there is no per-operation leak to watch for and no worker recycling.

### Appearance and color modes (issue #67)

PDFs are fixed-layout rasters: the reader's reflow controls (font size,
spacing, family, alignment, columns, layout, margins) apply only to EPUB
and are not displayed for PDFs — the appearance menu offers exactly the
theme, which for PDFs is really a set of **color modes**
(`lib/pdf/theme.ts`, driven by the same stored reader theme as EPUB):

- **Default / Light** — pages render as-is.
- **Paper** — multiply-tints the white pages to the theme's own paper color
  (a CSS filter cannot darken white).
- **Dark = Smart dark** — category-level recoloring _inside the PDFium
  worker, before rasterization_ (ADR 0002): the seam's palette maps onto
  PDFium's `FPDF_COLORSCHEME` (`colorSchemeFromPalette` in
  `lib/pdf/smartColors.ts`), which remaps path fills and strokes and text
  fills and strokes onto the dark palette. Path fills take the page
  background, text takes the light text colour, and the cross terms (path
  stroke, text stroke) are the opposite endpoint so converted fills stay
  visible against their fill; `FPDF_CONVERT_FILL_TO_STROKE` strokes fills so
  adjacent fills do not merge into the background. Pages without an explicit
  background fill are pre-filled with the scheme's path fill (PDFs do not
  paint their own page background; viewers supply the white). Images are not
  a colour-scheme category, so photographs, covers, and screenshots keep
  their pixels. A coloured vector fill loses its hue (all path fills share
  one colour), the accepted degradation from the retired object-level
  recoloring.

- **Invert** — the explicit full-page negative (`invert(1)
hue-rotate(180deg)`, the recipe Foliate popularized), kept from the old
  Dark behavior for users who actually want inversion. A CSS filter over
  the document surface, like High contrast (`grayscale + invert +
contrast`).

The recolor-only EPUB presets (Blue, Mint) have no faithful raster
treatment and remain EPUB-only. "Invert" is a PDF-only stored theme name
(`ReaderTheme` in `lib/epub/appearance.ts`); consumers with EPUB semantics
normalize it to the dark preset via `epubSurfaceTheme` so a pick made on a
PDF never reaches EPUB engines or shell chrome as an unknown name.

#### Scanned and rasterized pages

A page that is one large image has no path or text categories to recolor,
so Smart dark leaves it as-is. Scanned-image classification, which would
detect a paper-backed scan and remap its pixels, is out of scope for the
first version of the colour scheme.

Color mode is part of the render and cache identity: the worker render
request carries the colour scheme only in Smart dark, and the per-document
bitmap cache (`pdfBitmapCache`) keys entries by `{page, scale, ratio,
variant}` where `variant` is `"original" | "smart"` — a mode switch
re-renders instead of serving the other mode's pixels. The shell chrome
around the surface follows the same theme in both formats.
