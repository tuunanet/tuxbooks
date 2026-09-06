# 4K scrolling performance — investigation handover

Findings from investigating "scrolling is smooth in the default window, but
PDF and EPUB scrolling degrade badly on a 3840×2160 display with the window
maximized". This document hands the problem to the next engineer: where the
cost is, what it is not, and what to change, in order.

Environment at investigation time: Kubuntu, 3840×2160, WebKitGTK 2.52.6
(Skia-based, GPU rendering default), pdfjs-dist 6.3.289, Tauri 2 / wry.

## Executive summary

The jank is **not** scroll-event handling — that path is already
rAF-coalesced and only touches React state on page change. The cost is
**pixel volume**: every surface the reader produces scales with viewport
area, and at 4K maximized that is 4–8× a 1080p window. Concretely, ranked:

1. **PDF pages rasterize with no resolution cap.** The canvas backing store
   is `fit-width viewport × devicePixelRatio` (PdfPageCanvas.tsx:106–121).
   Maximized at 4K that is ~70–300 MB _per page_ rasterized on the main
   thread (PDF.js paint loop is time-sliced main-thread work). The official
   PDF.js viewer caps canvas pixels and CSS-upscales instead — TuxBooks
   bypasses that policy.
2. **The bitmap LRU cache is dead weight at 4K.** Its 48 MB budget is
   smaller than one 4K page buffer, so scrolling back re-rasterizes every
   heavy page (pdfBitmapCache.ts:18).
3. **Up to 8 giant live canvases + compositing effects.** `shadow-sm`,
   border, and rounded corners on multi-megabyte canvas layers
   (PdfPageCanvas.tsx:147) force WebKit to composite expensive large
   surfaces every frame while scrolling.
4. **EPUB paginated turns rasterize a full-viewport CSS column per flip**;
   scrolled mode rasterizes whole-section iframes — both scale with the
   4K viewport through WebKitGTK's 512×512 tile painting.

The durable contract distilled from these findings — the budgets, their
status, and how each is verified — lives in `docs/performance.md`.

## The math (why the window size matters so much)

A letter page is 612×792 pt. Fit-width scale = content width / 612.
Buffer bytes = displayed W × H × dpr² × 4 (RGBA):

| Window                   | Fit scale | Buffer (dpr 1)   | Buffer (dpr 1.5) | Buffer (dpr 2)   |
| ------------------------ | --------- | ---------------- | ---------------- | ---------------- |
| Default 1100×720         | ~1.7      | ~1.4 MP / 6 MB   | 3.2 MP / 13 MB   | 5.7 MP / 23 MB   |
| Maximized 1920×1080      | ~3.0      | ~4.4 MP / 18 MB  | 10 MP / 40 MB    | 17.7 MP / 71 MB  |
| Maximized 3840×2160 (4K) | ~6.2      | ~18.6 MP / 75 MB | 41.9 MP / 168 MB | 74.5 MP / 298 MB |

That matches the symptom exactly: smooth at 1100×720 (single-digit MB),
rough at 4K where one page buffer exceeds the entire bitmap cache budget
and each raster is 10–50× the default window's cost. Zoom multiplies on top
(`scale = fitScale × zoom`, PdfReader.tsx:146; zoom 1.5 at 4K ≈ 64 MB–380 MB
per page).

## Worst bottlenecks, with evidence

### PDF-1 — No canvas resolution cap (primary)

`PdfPageCanvas` sizes the render buffer at full displayed resolution
(`buffer.width = viewport.width * ratio`, PdfPageCanvas.tsx:109–111) and
renders via `page.render({ canvas, viewport, transform })`
(PdfPageCanvas.tsx:117–121). Nothing bounds the pixel count.

The official viewer (same engine, `pdfjs-dist` 6.3.289) deliberately does
otherwise — verified in `mozilla/pdf.js` source via GitHits:

- `web/app_options.js`: `maxCanvasPixels` defaults to `2 ** 25` (33.5 MP)
  on desktop; a compat param caps mobile at 5 MP.
- `test/integration/viewer_spec.mjs`: above the cap the viewer does
  "CSS-only zoom" — canvas rendered at capped resolution, stretched by CSS.
- `web/pdf_page_detail_view.js`: zoomed detail is re-rendered at full
  resolution only for the visible region (`enableDetailCanvas`), still
  constrained by the cap.

PDF.js paint loops run time-sliced **on the main thread** (stated in
docs/pdf.md and confirmed against mozilla/pdf.js v6 in PdfReader.tsx:42–54),
so an 18–75 MP raster competes with scrolling directly. At dpr 2 the 4K
buffer (298 MB) also approaches WebKit canvas texture limits
(15168×... px vs the common 16384 max texture dimension).

### PDF-2 — Bitmap cache thrash at 4K (primary)

`DEFAULT_BUDGET_BYTES = 48 MB`, `DEFAULT_MAX_ENTRIES = 8`
(pdfBitmapCache.ts:18–21). One 4K page at dpr 1 is ~75 MB — over the whole
budget — so `#trim` evicts down to the single "never evict the last" entry
(pdfBitmapCache.ts:89–96). The design intent ("scrolling back never
re-pays the raster", docs/pdf.md) silently fails at 4K: every scroll-back
re-rasterizes. `data-pdf-bitmap-cache` on the reader element
(PdfReader.tsx:621) exposes this live: at 4K it will read `1:<huge>` and
never accumulate.

### PDF-3 — Live canvas memory + compositing effects (secondary)

`MAX_ACTIVE_CANVASES = 8` (PdfReader.tsx:40): up to 8 page canvases stay
mounted inside the preload window. At 4K that is 0.5–2 GB of canvas backing
stores feeding WebKitGTK's tile compositor. Each canvas also carries
`rounded-sm border bg-white shadow-sm` (PdfPageCanvas.tsx:147) — rounded
clip + shadow on a page-sized layer is per-frame compositing work that is
invisible at 1 MP and measurable at 19–75 MP. The completion blit also
reassigns `canvas.width` (full backing-store realloc) before a full-surface
`drawImage` on the main thread (PdfPageCanvas.tsx:32–37).

### PDF-4 — Preload window grows with the viewport (minor)

`PRELOAD_ROOT_MARGIN = "100% 0px 100% 0px"` (usePdfVirtualization.ts:4) is
one viewport height per side — at 4K that is ±2160 px of extra pages racing
through the 2-render pipeline while the user scrolls. Bounded by
MAX_ACTIVE_CANVASES, so it costs render churn, not unbounded memory.

### EPUB-1 — Paginated turns rasterize viewport-sized CSS columns

Default flow is paginated (readerState.ts:28). The vendored foliate-js
paginator lays each section iframe out in CSS multi-columns with
`column-width` = viewport width (paginator.js:309–318), so at 4K one page
turn paints a ~3840 px wide column through WebKitGTK's 512×512 tile grid.
`relayout()` (engine re-pagination after fonts settle, EpubReader.tsx:447–465)
re-columnizes the whole section — a full re-raster at section mount.

### EPUB-2 — Scrolled flow: whole-section iframe layers

In scrolled flow the section iframe is one tall layer; WebKitGTK paints
scroll-in tiles as "follow up requests" (WebKitGTK Graphics docs — see
external evidence below), so fast 4K scrolling outruns tile production and
shows checkerboarding/lag. Relocate handling is already debounced 250 ms
upstream (paginator.js:560–565), so this is raster volume, not event
storms.

### Environment-1 — Silent slow paths in the GPU stack

Per the Tauri "Linux Graphics Issues" doc and WebKitGTK documentation:

- `WEBKIT_DISABLE_DMABUF_RENDERER=1` (common NVIDIA workaround) gives up
  the fast rendering path; `WEBKIT_DISABLE_COMPOSITING_MODE=1` disables
  accelerated compositing entirely — either makes 4K scrolling
  CPU-copy-bound.
- Canvas content can silently land on a software/slow path with no
  catchable error; WebKitGTK also masks the WebGL renderer string, so the
  app cannot detect it from inside the frontend.
- Kubuntu display scaling sets `devicePixelRatio`; every point of dpr
  multiplies all raster costs above by dpr².

The installed WebKitGTK 2.52.6 is modern and fast by default (Skia GPU
rendering; tiles painted in worker threads since 2.48), so the fix is not
"upgrade WebKit" but "don't set the escape hatches, and verify hardware
compositing is actually active on affected machines".

## What is NOT the bottleneck (don't chase these)

- **Scroll event handling** — rAF-coalesced, binary-search page lookup,
  React state only on page change (usePdfScrollTracking.ts:43–48,
  pdfLayout.ts:101). Same for EPUB (250 ms debounce in paginator.js).
- **IPC/Rust** — `get_book_bytes` answers raw bytes (no JSON encoding),
  progress saves are debounced 1 s, and nothing on the Rust side runs
  per scroll frame.
- **Thumbnails** — fixed 112 px cells, own 12-canvas budget; unaffected by
  4K.
- **Geometry corrections** — `measurePages` is idempotent per page; not a
  per-scroll cost.
- **Search/outline/highlights** — off the scroll path.

## Suggested improvements (in order)

1. **Cap the render buffer, upscale via CSS** (PDF-1). In
   `PdfPageCanvas`, compute `ratio = min(devicePixelRatio, cap)` against an
   area budget (start at PDF.js's `2 ** 25` pixels; consider ~16 MP
   first — 4K dpr 1 pages then stay at ~75% of cap). Render the buffer at
   the capped ratio, keep `width`/`height` CSS at displayed size. Cache
   keying (`PdfBitmap.scale`) already handles distinct render scales.
   Effort: small; localized to one effect. Tests: extend the existing
   PdfPageCanvas unit tests with a dpr/pixel-cap matrix (jsdom devicePixelRatio).
2. **Make the bitmap cache budget pixel-aware** (PDF-2). Scale
   `DEFAULT_BUDGET_BYTES` with measured page bytes (e.g. accept ~2–3
   buffers at current page size, or a flat 192 MB), and/or store
   capped-resolution bitmaps (they are, after fix 1). Keep
   `data-pdf-bitmap-cache` as the acceptance signal: `entries` should
   reach 2+ while scrolling a 4K window.
3. **Budget live canvases by bytes, not count** (PDF-3). Convert
   `MAX_ACTIVE_CANVASES` into a byte budget (count as fallback), so 4K
   windows keep ~3–4 canvases while 1080p keeps 8. Drop `shadow-sm`
   (or move the page chrome to the slot's CSS at the wrapper level);
   rounded corners on the wrapper clip cheaply, shadows on page-sized
   layers do not.
4. **Blit without realloc** (PDF-3). Only assign `canvas.width/height`
   when dimensions actually changed; otherwise `drawImage` into the
   existing backing store.
5. **Viewport-relative preload** (PDF-4). Express `PRELOAD_ROOT_MARGIN`
   in px (e.g. ±1080 px) instead of viewport %, so 4K windows preload a
   bounded region rather than ±2160 px.
6. **Zoom ceiling awareness** (PDF-1). At 4K fit-width is already ~6×;
   `ZOOM_LEVELS` up to 2× yields ~12× rasters. After fix 1 this is safe
   (cap keeps buffers bounded, CSS zoom absorbs the rest), but verify the
   text layer (`--scale-factor`) still matches the visible scale.
7. **EPUB: bounded content width at very wide viewports** (EPUB-1/2).
   foliate-js exposes margins/max-column-count to the paginator; offering
   a spread (2-up) or max measure at wide windows halves per-turn raster
   width. Exploration, product decision — paginated turns are discrete,
   so this is the EPUB item to measure first with the row below.
8. **Diagnostics before/with any change.** Log at reader mount: dpr,
   content area size, fit scale, WebKitGTK version, and whether
   `WEBKIT_DISABLE_DMABUF_RENDERER`/`WEBKIT_DISABLE_COMPOSITING_MODE`
   are set. Record `data-pdf-bitmap-cache` and per-render durations
   (`performance.now()` around `page.render`) into `data-pdf-*` attrs
   like the existing cache attr. Sysprof tracing marks land in WebKit
   2.50+ for frame-level attribution.

## How to reproduce / measure

- Reproduce: open any PDF, maximize on the 4K screen, scroll with the
  wheel and by dragging the scrollbar; watch `data-pdf-bitmap-cache` and
  `data-render-state` churn in the devtools inspector.
- Compare: `WEBKIT_DISABLE_COMPOSITING_MODE=1 tuxbooks` should be
  dramatically worse; if it is _not_ worse, hardware compositing was
  already inactive — fix the GPU stack first (Tauri linux-graphics
  workarounds) before touching app code.
- After fix 1: the same scroll at 4K should show buffer sizes pinned near
  the cap (log them), with visible-page rasters dropping from
  hundreds of ms to tens.

## External evidence

- mozilla/pdf.js (GitHits, source): `web/app_options.js` —
  `maxCanvasPixels` default `2**25`, mobile compat cap 5 MP;
  `test/integration/viewer_spec.mjs` — "CSS-only zoom above
  maxCanvasPixels"; `web/pdf_page_detail_view.js` — detail canvas bounded
  by the cap.
- WebKitGTK Graphics documentation
  (docs.webkit.org, Ports/WebKitGTK and WPE WebKit/Graphics): 512×512
  tile backing stores, threaded rendering/compositing, async scrolling
  "when possible", scroll-ahead tiles painted as follow-up requests.
- webkitgtk.org 2.48 release notes: GPU Skia renders tiles in worker
  threads (default), improving throughput.
- Tauri "Linux Graphics Issues" (v2.tauri.app): DMABUF/NVIDIA workarounds
  ranked by cost; canvas/WebGL can silently fall to slow paths; warning
  against unconditional `WEBKIT_DISABLE_DMABUF_RENDERER` overrides;
  tauri-apps/tauri#7021 (WebKitGTK 2.40 sluggishness reports).
