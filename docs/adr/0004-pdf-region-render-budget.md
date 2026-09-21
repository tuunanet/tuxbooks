# ADR 0004: Bound the PDF region render device scale

Status: accepted
Date: 2026-09-21
Decides: how the PDF reader bounds the raster device scale in region mode so deep zoom cannot exhaust the PDFium WASM heap, and which of the five candidate fixes to take now
Relates to: ADR 0002, ADR 0003, `docs/PDF-VIEW.md`, `docs/PERFORMANCE.md`

## Context

Region mode (`PdfPageCanvas`) renders only the visible region once the whole-page
raster would fall below the display's device resolution, so text stays sharp at
deep zoom. PDFium runs in a worker compiled to WebAssembly with a 2 GB heap that
never shrinks. A single RGBA bitmap is 4 bytes per pixel, so anything past 2^25
pixels cannot be allocated at all.

The assumption behind region mode was that a clipped render's cost is dominated
by interpreting the page, and is therefore roughly independent of the clip's
area. That is false for page-sized drawing objects. PDFium sizes internal
buffers for a shading's pattern by the render's **device scale over the object's
full page box**, not by the clip. Measured with `dphi_GRANIITTI_MC.pdf` on a
dpr-2 display:

- Sweeping device scale: the WASM heap jumps from 62 MB to **1285 MB in one
  render** at device scale ~43.
- Isolating one render per fresh engine at device scale 43: a clip of ~84 page
  units allocates **433 MB**, ~42 units **383 MB**, and ≤21 units **17.8 MB**.
  The allocation tracks the clip's page area at that device scale.

The region ratio only bounded the region buffer, which is small, so the device
scale was free to reach `scale × dpr`. The emscripten heap never shrinks, so the
high-water ratcheted up render by render until it could not grow and every later
render failed with `Cannot enlarge memory` (the doubled grow request is the
3.6 GB in the report). The user-visible repro was: zoom in gradually to 10000%,
then zoom out. Zoom-out walks through the spike scale while the viewport sits on
the plot's hatched shading bands.

## Decision

**D1. Clamp every render bitmap in the engine.**
`PdfiumEngine.renderRgba` clamps width and height to `MAX_RENDER_BITMAP_PIXELS`
(2^25), preserving aspect, before `FPDFBitmap_Create`. This is a last-line net:
a caller that slips past the ratio policies degrades to a CSS-upscaled raster
instead of asking the 2 GB heap for more than it can hold.

**D2. Cap the region ratio by the whole-page budget (option A).**
`regionRenderRatioForPage` returns
`min(regionRenderRatio(region), effectiveRenderRatio(page))`. This holds the
page's device scale inside the 2^25-pixel budget, which bounds the internal
shading allocation because that allocation scales with the page's device extent.
`PdfPageCanvas` uses it when `needsRegionRender` is true.

**D3. Take option A now.**
It is unconditional, so it is guaranteed safe. The cost is that region rasters
no longer reach device resolution at extreme zoom, for every document, not only
shaded ones. At dpr 2 the plot renders at device scale ~22 instead of 43
(2150%) or 200 (10000%), so text and hairlines are soft at deep zoom.

**D4. Prefer option B next.**
Cap only pages that actually contain a shading, so text PDFs keep sharp deep
zoom. Tracked as `tuxbooks-c5h`. It is a refinement of the same cap, not a new
mechanism.

## Considered options

- **A. Unconditional cap (chosen).** Simplest, always safe, soft deep zoom
  everywhere.
- **B. Cap only pages containing a shading.** Ask PDFium for the page's objects
  (`FPDFPage_CountObjects` → `FPDFPage_GetObject` → `FPDFPageObj_GetType ==
FPDF_PAGEOBJ_SHADING`), cache per page, and cap only those. Text PDFs regain
  sharp deep zoom; shaded plots stay soft but safe. Cost is plumbing through
  engine → worker → adapter → reader → canvas, and the detection is coarse (a
  shading anywhere on the page caps the whole page).
- **C. Tile the region render** into clips below the safe page area. Measured
  safe size: ≤ ~21 page units at device scale 43 (17.8 MB). Preserves full
  device resolution for any content and bounds the allocation, but each region
  becomes several PDFium calls that re-parse the page, so region renders get
  slower. Rejected for now on render cost; revisit if B's coarse cap is not
  good enough.
- **D. Move PDFium to the native sidecar**, removing the WASM ceiling. Removes
  the root cause and restores full sharpness. Rejected for now as a large
  architectural change to the engine seam (ADR 0002).
- **E. Lower `MAX_ZOOM` so the spike scales are unreachable.** Rejected. GNOME
  Papers has no fixed max zoom: it derives one per document from a byte cache,
  `max_scale = min(sqrt(page_cache_size / (4·maxW·maxH)), 32767/maxH,
32767/maxW)` (`libview/pps-view.c:5655`, `MIN_SCALE` at `:28`,
  `MAX_IMAGE_SIZE` at `:5652`), with `page-cache-size` defaulting to 200 MiB
  (`org.gnome.Papers.gschema.xml`). That is roughly 1040% for a letter page and
  2747% for this plot, and it is user-adjustable and page-size and dpr
  dependent. A single constant would cap more than Papers does on small pages,
  less than the spike on high-dpr displays, and would not scale with the cache.
  Papers also tolerates the large allocation because cairo memory is native and
  dimension-capped at 32767; the fatal part here is our 2 GB WASM ceiling, which
  a zoom cap does not fix.

## How to switch

- **B**: add a `pageHasShading(page)` query to `PdfiumEngine` (`FPDFPage_*Obj*`
  iteration), expose it beside `pageSize` in the worker and adapter, cache it in
  the reader, pass a `hasShading` prop to `PdfPageCanvas`, and use
  `regionRenderRatioForPage` only for pages where it is true.
- **C**: in `PdfPageCanvas.renderInto`, split the region rect into tiles whose
  clip page area stays under the safe threshold and blit each tile into the
  region buffer.
- **D**: replace the WASM engine seam with the native sidecar renderer; the
  `PdfDocument` interface (ADR 0002, ADR 0003) is the seam to implement against.
- **E**: `MAX_ZOOM` and `clampZoom` in `frontend/src/components/reader/pdf/pdfLayout.ts`.
- A is composed in `PdfPageCanvas` where the render ratio is chosen; the engine
  clamp (D1) stays regardless of A–E.

## Consequences

- Deep zoom region rasters are soft at extreme zoom for all documents until B is
  taken. The softness is proportional to how far past the budget the zoom goes.
- No render can request a bitmap the 2 GB heap cannot hold; the worst case is a
  blurry frame, not a dead renderer.
- `pdfZoomTelemetry` already records `canvasRegion`, `canvasBuffer`, and scale,
  and the worker reports `heapBytes` per request, so the next tuning pass has
  the data.
- Option B is tracked as `tuxbooks-c5h`.

## Evidence

- `frontend/tests/pdfBitmapCap.test.ts`: `MAX_RENDER_BITMAP_PIXELS` clamp and a
  27950×24850 render returning a bounded bitmap.
- `frontend/tests/pdfRenderPolicy.test.ts`: `regionRenderRatioForPage` holds the
  page's device area inside the budget across scales 11–100 and leaves the plain
  region ratio when the page fits.
- `frontend/tests/PdfPageCanvas.test.tsx`: region placement and remap
  regressions.
- Real app, plot at dpr 2: zoom 2150% → 4300% → 10000% and back through every
  scale, worker heap flat at 110.1 MB, no `Cannot enlarge memory` lines.
- Commits: `b460e00` (engine clamp), `0f97f01` (region device-scale cap), with
  `d3f5570` and `76e9f31` fixing the focal anchor and the blank page that
  preceded this work.
