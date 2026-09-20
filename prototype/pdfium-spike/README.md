# PDFium-WASM Phase 0 spike (tuxbooks-koe.2)

Throwaway prototype. It answers the Phase 0 kill criteria for replacing
MuPDF.js with PDFium-WASM. The deliverable is a decision, not shipped code.
Do not merge this branch.

## Package choice

`@embedpdf/pdfium@2.15.0`, MIT.

- It exposes the raw PDFium C API (`FPDF_*`, `EPDF_*`) through a thin
  Emscripten binding, which the plan needs for `FPDF_LoadCustomDocument` with
  `FPDF_FILEACCESS`, `FPDF_RenderPageBitmapWithMatrix`, and `FPDF_COLORSCHEME`.
- It is maintained: 89 published versions, with 2.15.1 published four days
  before this spike. 2.15.0 is the newest release older than the repo's
  30-day `minimumReleaseAge`, so it is the version the supply-chain rule
  allows today.
- MIT is compatible with GPL-3.0-or-later.
- The other candidates are weaker here. `@hyzyla/pdfium` is a higher-level
  render wrapper, not the raw C surface this plan is written against.
  `pdfium-wasm` (2023) and `pdfium.js` (0.2.1-rc, 2024) are stale.

## How to run

```sh
npm install
node runner/run-spike.mjs                       # defaults to the GeoTopo fixture
SPIKE_PDF=/path/to/book.pdf SPIKE_LABEL="book" SPIKE_NEEDLE="word" node runner/run-spike.mjs
```

The runner bundles `browser/worker.js` to `dist/worker.js`, serves it with the
staged `pdfium.wasm` over HTTP with byte-range support, and runs it in a real
classic Web Worker under Chromium (`/usr/bin/chromium-browser`). The worker
opens the PDF through a synchronous-XHR range source, renders, and returns a
JSON report. Reports land in `reports/`.

`src/probe.mjs` and `src/probe-colorscheme.mjs` are the lower-level Node
probes used to work out the struct layouts and the color-scheme contract.

## Result: PASS

All three fixtures rendered, opened range-backed, and exercised text, outline,
search, and `FPDF_COLORSCHEME` inside the worker.

| Fixture              | Pages | File     | Bytes read        | Open ms | First render ms | First paint ms | Whole native p95 ms | Region dpr2 p95 ms |
| -------------------- | ----- | -------- | ----------------- | ------- | --------------- | -------------- | ------------------- | ------------------ |
| GeoTopo.pdf          | 117   | 5.32 MB  | 0.69 MB (13%)     | 64.4    | 99.0            | 190.5          | 10.0                | 71.2               |
| ai-engineering.pdf   | 991   | 31.29 MB | 2.04 MB (6.5%)    | 120.8   | 79.5            | 225.9          | 28.8                | 225.7              |
| pdflatex-outline.pdf | 4     | 0.049 MB | whole (tiny file) | 47.3    | 103.6           | 179.8          | 2.9                 | 29.8               |

`first render` is page 0 from a cold worker, so it includes cold font and page
parsing. Later pages rasterize in single-digit milliseconds.

### Kill criteria

1. **Rasterize inside the worker: pass.** A real classic Web Worker (the shape
   Emscripten's browser build needs) ran every `FPDF_*` call and every range
   read. Chromium 153, headless.

2. **Byte budget: pass.** PDFium is smaller than the engine it replaces:

   | Artifact       | PDFium 2.15.0         | MuPDF 1.28.1 |
   | -------------- | --------------------- | ------------ |
   | WASM raw       | 4,633,788 B (4.42 MB) | 10,409,826 B |
   | WASM brotli    | 1,649,352 B           | 3,622,011 B  |
   | JS glue raw    | 287,276 B             | 132,111 B    |
   | JS glue brotli | 41,858 B              | 26,097 B     |

   Total is 47% of MuPDF raw and 46% brotli. The ADR estimate of 6 to 11 MB
   was pessimistic.

3. **Range-backed open: pass.** `FPDF_LoadCustomDocument` with
   `FPDF_FILEACCESS` and a synchronous-XHR `m_GetBlock` callback. On the
   31.29 MB, 991-page book it issued 222 range reads for 2.04 MB (6.5%) and
   opened in 120.8 ms; the whole file never crossed. The 5.32 MB book read
   0.69 MB (13%) over 189 requests. The 48 KB fixture is smaller than the
   read-ahead and is read whole; that is expected, not a defect.

4. **Performance caps: partial pass, with a named risk.**
   - Native whole-page raster p95 is 2.9 to 28.8 ms, far under PERF-2's
     100 ms.
   - The reference dpr-1 viewport region (3840x2160) rasters in 1.5 to
     71.9 ms, under 100 ms.
   - The reference dpr-2 region (7680x4320, the PERF-1 maximum) rasters in
     29.8 to 225.7 ms. Image-heavy pages exceed 100 ms.
   - The existing MuPDF baseline is p50 147.5 / p95 176.5 ms
     (`docs/PERFORMANCE.md`, PERF-2). PDFium is comparable to or better than
     that on text and vector pages, but the 100 ms PERF-2 target is not met
     at dpr 2 on image-heavy pages. It is not met today either. Pushing
     7680x4320 through either engine is CPU rasterization, so Poppler-WASM is
     unlikely to change this. Treat PERF-2 as a re-baseline, not a kill.
   - Region rendering works and is the right tool: on GeoTopo the reference
     region rasters in 8.7 ms against 63.2 ms for the whole page, into 33.2 MB
     instead of 83.4 MB. PERF-17 holds.
   - First paint (worker start to first page) is 179.8 to 225.9 ms, of which
     25 to 29 ms is WASM init and 47 to 121 ms is the range-backed open.
     PERF-14 has no numeric threshold, and engine prewarm removes the init
     segment from the critical path.

5. **Capability floor: pass, with one integration detail.**
   - Text: `FPDFText_LoadPage`, `CountChars`, `GetText`, plus the per-character
     geometry calls (`GetCharBox`, `GetCharOrigin`, `GetRect`,
     `CountRects`, `GetCharIndexAtPos`, `GetMatrix`) are all present.
   - Outline: `FPDFBookmark_GetFirstChild`, `GetNextSibling`, `GetTitle`, and
     the page-locator path (`FPDFBookmark_GetDest` then
     `FPDFDest_GetDestPageIndex`) are present. The smoke read titles and
     counts.
   - Search: `FPDFText_FindStart`, `FindNext`, `GetSchCount`. Matched 9, 3, and
     3 on the fixtures.
   - Color scheme: `FPDF_COLORSCHEME` recolors by category and was verified
     (3552 / 6478 / 1742 non-white pixels on the three fixtures).
   - Integration detail: the only color-scheme entry point is the progressive
     `FPDF_RenderPageBitmapWithColorScheme_Start`. It requires a valid
     `IFSDK_PAUSE` (version 1, `NeedToPauseNow` callback); passing a null pause
     returns status 3 (`FPDF_RENDER_FAILED`) and draws nothing. There is no
     color-scheme variant of `FPDF_RenderPageBitmap` or
     `FPDF_RenderPageBitmapWithMatrix`, so dark region rendering must use the
     progressive path too: drive with `FPDF_RenderPage_Continue`, finish with
     `FPDF_RenderPage_Close`. Status enum from PDFium `fpdf_progressive.h`:
     0 ready, 1 to-be-continued, 2 done, 3 failed. No required API was
     missing from the binding.

## Verdict

PDFium-WASM passes. It rasterizes in the renderer worker, opens range-backed,
stays under the byte budget, and meets the capability floor. The only caveat
is the PERF-2 number at dpr 2 on image-heavy pages, which mirrors the current
baseline and does not justify reopening the engine. ADR 0002 can move from
proposed to accepted at ticket `tuxbooks-koe.4`. Poppler-WASM is not needed.

## Artifacts

- Branch: `prototype/pdfium-wasm-spike` (worktree `.worktrees/pdfium-spike`).
- Reports: `reports/geopoto.json`, `reports/ai-engineering.json`,
  `reports/pdflatex-outline.json`.
- Runner: `runner/run-spike.mjs`; worker: `browser/worker.js`.
