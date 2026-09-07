# Performance budgets and metrics

The readers are budgeted in **pixels and bytes, not element counts**. Every
surface they produce scales with viewport area, and the app must stay smooth
at a maximized 3840×2160 window — not just at the default 1100×720 size.

Like the coverage gate (`docs/coverage.md`), budgets are changed only case
by case, with the reason recorded in the same change. Unlike coverage, not
every budget is machine-enforced yet; the Verified-by column states what
holds each one today, and what must hold it in a change that touches it.

## Reference conditions

All numeric budgets are evaluated at: maximized window on 3840×2160,
devicePixelRatio 1.0 **and** 2.0, letter PDF page (612×792 pt) at fit-width
zoom 100%, EPUB default (paginated) flow, current Electron/Chromium.
A change that makes any budget worse at reference conditions must state the
measured delta in the PR description.

Chromium does not automatically guarantee good performance — budget
regressions under Electron are re-measured, not assumed away. Do not
treat Chromium's compositing as a substitute for the pixel/byte budgets.

## Budgets

| ID      | Metric                                                      | Required                                                                                                                                          | Status (2026-09-07)                                                                                                                                                      | Verified by                                                                          |
| ------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| PERF-1  | PDF page canvas backing store (`displayed px × dpr²`)       | ≤ 2²⁵ px total **and** ≤ 8192 px per dimension; CSS upscales beyond that                                                                          | Two-tier cap (`pdfRenderPolicy`): prefers dpr → degrades to the soft tier → CSS-resolution floor → hard cap under zoom. Carry over unchanged through the MuPDF migration | Unit test pinning the cap math (`pdfRenderPolicy.test.ts`, jsdom `devicePixelRatio`) |
| PERF-2  | Visible-page raster latency (render start → blit)           | p95 ≤ 100 ms at reference conditions                                                                                                              | WebKitGTK-era measurements are void under Chromium: re-baseline on the new stack in migration phase 6 before enforcing                                                   | Manual measurement (`just bench-reader`); diagnostic attrs                           |
| PERF-3  | Bitmap cache occupancy after one down-up scroll oscillation | ≥ 2 buffers retained; cache byte budget ≥ 2 × largest page buffer                                                                                 | 320 MB budget ≥ 2 × capped 4K buffer at both reference dprs; unit tests pin both                                                                                         | `data-pdf-bitmap-cache` attr + unit test on budget math                              |
| PERF-4  | Total bytes of mounted page canvases                        | ≤ 256 MB at reference conditions (byte budget governs; count cap stays ≤ 8)                                                                       | Byte-budgeted render window (`MAX_ACTIVE_CANVAS_BYTES`)                                                                                                                  | Derived from slot/canvas state in unit tests                                         |
| PERF-5  | React state commits from scrolling                          | ≤ 2 per 1000 px of continuous scroll (page/section changes only); scroll handlers rAF-coalesced                                                   | Do not regress                                                                                                                                                           | Vitest with synthetic scroll events                                                  |
| PERF-6  | Compositing hygiene                                         | No `box-shadow`/`filter`/`backdrop-filter`/`blur` on page-sized or larger layers (canvases, EPUB iframes); decorations live on cheap wrappers     | Review + `grep` over reader components                                                                                                                                   | Review + `grep` over reader components                                               |
| PERF-7  | EPUB relocation debounce                                    | ≥ 200 ms in continuous/scrolled flow                                                                                                              | Re-establish with Readium's navigator settings at migration phase 3; never override the engine's own debounce downward                                                   | Code review when touching navigator settings                                         |
| PERF-8  | EPUB paginated per-turn raster volume                       | ≤ 1 viewport area per page turn (one column/viewport)                                                                                             | Re-establish with Readium at phase 3 (Readium CSS pagination)                                                                                                            | Review when touching navigator/pagination settings                                   |
| PERF-9  | Reading-progress write discipline                           | Saves debounced ≥ 1 s; first armed save skipped (opening writes nothing)                                                                          | `useReaderProgress` contract — engine-agnostic, survives the migration                                                                                                   | Existing `useReaderProgress` unit tests                                              |
| PERF-10 | Book payload transport                                      | Raw bytes via `tuxbooks://` (range requests), never JSON/base64-encoded growth                                                                    | New protocol replaces the old raw-IPC path; verify no base64 inflation over the bridge                                                                                   | E2E + review of the protocol handler + sidecar reader service                        |
| PERF-11 | Renderer hygiene                                            | No GPU-workaround env flags in shipped code (`ELECTRON_*`/`--disable-gpu` without cause); startup logs dpr, content area, fit scale               | Chromium replaces the WebKitGTK dmabuf/compositing-flag minefield; any Electron `app.commandLine` GPU flags need a written reason here                                   | `grep` + review + `data-pdf-render-info` attr                                        |
| PERF-12 | EPUB scrolled reading-surface width                         | ≤ 960 px inline (`EPUB_SCROLLED_SURFACE_MAX_PX`), centered; paginated flow stays uncapped — the engine's pagination bounds its spread             | Re-establish with Readium's scrolled view at phase 3; the cap keeps the composited surface near the text column                                                          | Unit tests pinning the cap + bench asserts the measure attribute                     |
| PERF-13 | Process overhead                                            | Sidecar is spawned once and reused; no per-turn IPC for operations that can stay inside the renderer (scroll, zoom, render); no chatty poll loops | New budget for the Electron stack — the bridge is for data/state, never per-frame traffic                                                                                | Review + bridge call-count assertions in unit tests where practical                  |

## Rules for changes

- Any change touching the touch-list below must re-read this doc and keep
  every budget at or better than required — the fix for a violation is a
  fix, not a raised threshold.
- Growing per-page raster pixels, per-frame composited area, or per-scroll
  main-thread work requires the measured delta at reference conditions in
  the PR description and updated pinning tests in the same change.
- New diagnostics must be deterministic DOM attributes (`data-*`), never
  timing assertions — E2E runs headless under `xvfb-run`, where timings are
  unreliable. Timing budgets (PERF-2) are measured manually or via logs,
  not asserted in CI.

## Touch-list

Re-run the relevant verifications when editing:

- `PdfPageCanvas` / `pdfBitmapCache` / `usePdfVirtualization` / `PdfReader`
  render-policy constants (`MAX_ACTIVE_CANVASES`, `MAX_CONCURRENT_RENDERS`,
  `ZOOM_LEVELS`) — PERF-1 to PERF-6.
- `usePdfScrollTracking`, `ReaderShell` scroll container — PERF-5, PERF-9.
- EPUB engine seam (Readium navigator options, flow/appearance wiring,
  scrolled-surface cap) — PERF-7, PERF-8, PERF-12.
- `useReaderProgress`, reader persistence — PERF-9.
- `tuxbooks://` protocol handler + sidecar `reader` service — PERF-10.
- Electron `app.commandLine` / GPU flags — PERF-11.
- Bridge call sites (renderer↔main↔sidecar) — PERF-13.

## How to measure

- **Unit (deterministic):** mock `devicePixelRatio` in jsdom and pin the
  cap/budget math (PERF-1, PERF-3, PERF-4) and scroll-commit counts
  (PERF-5, synthetic scroll events).
- **E2E (deterministic attrs only):** assert on `data-pdf-bitmap-cache`
  (`entries:bytes`) and `data-render-state` churn — e.g. cache occupancy
  after a scripted scroll oscillation.
- **Bench suite (headed, explicit):** `just bench-reader [WxH]` runs the
  `bench-reader.e2e.ts` suite on the real display, maximized: the PDF
  scenario collects `data-pdf-render-ms` per walked page (PERF-1/3/4
  budget checks asserted) and both readers get a synthetic scrollbar drag
  (continuous scroll deltas per ~16 ms tick) with a rAF frame-interval
  sampler — p50/p95 frame time and the share of frames over 32/50 ms are
  the smoothness metrics — writing
  `artifacts/e2e/<runId>/bench-results.json`. Never runs in CI — timings
  are unreliable headless and the suite is the manual-measurement tool for
  PERF-2.
- **Manual (timings):** log `performance.now()` around render → blit per
  page at reference conditions; record p95 before/after engine, scale, or
  virtualization changes. Chromium DevTools performance panel and
  `chrome://tracing` replace the WebKitGTK-era Sysprof workflow.

## Legacy notes (WebKitGTK era, kept for context)

The old stack capped the webview frame clock at ~31 fps idle on Wayland
(reproduced in bare GTK hosts; root cause WebKit bug 315997) — PERF-2
p95 measurements from before the migration reflect that environment, not
the app. Historical analysis: `docs/research/webview-frame-clock.md`,
`docs/performance-4k.md`, `docs/research/reader-perf-bench-handover.md`.
Re-baseline everything on Chromium in migration phase 6; do not carry
WebKitGTK-specific tuning decisions forward.
