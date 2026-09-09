# 4K scrolling performance — implementation plan

> **Status (2026-09-06):** Phases 0–5 implemented and measured; Phase 6.1
> and 7.1 remain manual items. Measured outcome: app pixel budgets are no
> longer the smoothness limiter — the webview frame clock runs at ~31 fps
> idle on the reference machine (environment-level, under investigation).
> Findings, measurements, and the ordered next levers live in
> `docs/research/reader-perf-bench-handover.md`; measurement tool:
> `just bench-reader`.

Concrete, ordered steps to fix the 4K jank diagnosed in
`docs/performance-4k.md`. Each step is a self-contained, PR-sized chunk with
its own tests and acceptance signal, and every budget touched maps to a row
in `docs/performance.md` — the Status column is updated in the same change
as the step that satisfies it. Order matters: the biggest win lands first
(render-buffer cap), and later steps reuse its policy module and assume its
capped buffer sizes.

Reference conditions for all numbers: maximized 3840×2160,
devicePixelRatio 1.0 and 2.0, letter PDF page at fit-width zoom 100%
(`docs/performance.md`).

## Phase 0 — Baseline + diagnostics (do first, ships with Phase 1)

### Step 0.1 — Reader diagnostics (PERF-11, PERF-2 signal)

- Files: `PdfReader.tsx`, `PdfPageCanvas.tsx`, `sidecar` main setup.
- Add a mount-time effect on the reader that writes one deterministic
  attribute, e.g. `data-pdf-render-info="dpr:1.5;w:3816;h:2136;scale:6.2"`.
- Log WebKitGTK version (`navigator.userAgent`) and whether
  `WEBKIT_DISABLE_DMABUF_RENDERER` / `WEBKIT_DISABLE_COMPOSITING_MODE` are
  set (Rust side, one `log::info!` in setup — nothing sets them today;
  keep it that way, grep-verified).
- In `PdfPageCanvas` (`page.render` + blit), wrap the work with
  `performance.now()` and publish the last 5 durations as
  `data-pdf-render-ms` on the canvas.
- Verify: attributes visible in devtools; manual 4K baseline recorded
  (buffer px, p95 render ms) **before** any policy change. Also run the
  sanity check from `docs/performance-4k.md` once:
  `WEBKIT_DISABLE_COMPOSITING_MODE=1` must be dramatically worse — if it is
  not, hardware compositing was already off; fix the GPU stack before any
  app code.
- Size: S.

## Phase 1 — Cap the render buffer (PDF-1 / PERF-1) — the primary fix

### Step 1.1 — Pure cap policy module

- New `pdfRenderPolicy.ts` (or extend `pdfLayout.ts`, the pure-math home):
  `effectiveRenderRatio(width, height, scale, dpr, { maxPixels = 2**25,
maxDimension = 8192 })` returns
  `min(dpr, sqrt(maxPixels/(w·h·s²)), maxDimension/(w·s), maxDimension/(h·s))`,
  floored at a minimum of 1. The buffer is CSS size × ratio; the canvas
  CSS `width`/`height` stay at displayed size (CSS upscales beyond the cap,
  same policy as the official PDF.js viewer).
- Tests: `pdfRenderPolicy.test.ts` pinning the dpr matrix (1, 1.5, 2 at
  3840×2160 letter fit-width ~6.2): buffers ≤ 33.5 MP (2²⁵ px) and
  ≤ 8192 px per side; ratio < dpr exactly when the cap binds. This is the
  PERF-1 pinning test.
- Size: S.

### Step 1.2 — Apply the cap in `PdfPageCanvas` + make the cache ratio-aware

- `PdfPageCanvas` render effect: use `effectiveRenderRatio`; pass the ratio
  as the render `transform` (already supported).
- Design point (current code): `PdfBitmapCache` is keyed
  `(pageNumber, scale)` (`pdfBitmapCache.ts` `get`), but the buffer now
  also depends on the effective ratio. Extend `PdfBitmap` with `ratio` and
  require an exact match in `get()` (same pattern as `scale`), so a resize
  across monitors never serves a stale low-ratio bitmap; a miss just
  re-renders once.
- Tests: extend `pdfBitmapCache.test.ts` (ratio mismatch misses). Existing
  `PdfReader.test.tsx` expectations (`data-pdf-bitmap-cache = "2:3877632"`,
  jsdom dpr 1) must stay green unchanged — the regression guard that the
  cap is inert below threshold.
- Verify: at 4K the logged buffer px pin near the cap; visible-page renders
  drop from hundreds of ms to tens (PERF-2 direction, manual measurement).
- Size: M.

## Phase 2 — Pixel-aware bitmap cache (PDF-2 / PERF-3)

### Step 2.1 — Raise the budget

- `pdfBitmapCache.ts` `DEFAULT_BUDGET_BYTES`: 48 MB → flat **192 MB**
  (≈ 2–3 capped 4K buffers; satisfies PERF-3's "≥ 2 × largest page
  buffer"). Keep `DEFAULT_MAX_ENTRIES = 8`. Alternative (only if review
  wants it dynamic): PdfReader computes the budget from measured page
  bytes — more moving parts; start flat.
- Update `pdfBitmapCache.test.ts`; add a test that two 75 MB buffers
  coexist under the default budget.
- Acceptance: `data-pdf-bitmap-cache` reaches `entries ≥ 2` after one
  down-up scroll oscillation at 4K (manual; optionally an E2E assertion on
  the attribute per `docs/performance.md`).
- Size: S.

## Phase 3 — Byte-budgeted live canvases + compositing hygiene (PDF-3 / PERF-4 + PERF-6)

### Step 3.1 — Byte budget for the render window

- `PdfReader.tsx` (`MAX_ACTIVE_CANVASES`, `renderOrder`): keep the count
  cap (≤ 8) as fallback; add `MAX_ACTIVE_CANVAS_BYTES` (256 MB, PERF-4)
  and slice `renderOrder` by cumulative slot buffer bytes
  (slot w×h × effectiveRatio² × 4, using Phase 1's policy module).
  Result: ~3–4 canvases at 4K, 8 at 1080p.
- Tests: pure slicing math in `pdfRenderPolicy`/`pdfLayout` tests (4K keeps
  ≥ 3, 1080p keeps 8); derived PERF-4 test from slot/canvas state.
- Size: M.

### Step 3.2 — Drop the shadow from page canvases

- `PdfPageCanvas`: remove `shadow-sm` (PERF-6 violation — box-shadow on a
  page-sized layer is per-frame compositing work); move
  `rounded-sm border bg-white` to the page wrapper (`PdfDocumentView` page
  wrapper or `PdfPageSlot`), which clips cheaply. Tailwind's global
  `border-box` keeps slot geometry stable; verify text-layer/highlight
  overlay alignment (both are positioned in the same relative wrapper, so
  the 1px border shift applies equally).
- Verify: existing `PdfReader.test.tsx` + screenshot check;
  `grep -n "shadow" frontend/src/components/reader/pdf/` comes back clean.
- Size: S.

## Phase 4 — Blit without realloc (PDF-3, small)

### Step 4.1

- `PdfPageCanvas` `blit()`: assign `canvas.width`/`canvas.height` only when
  they actually changed; otherwise `drawImage` straight into the existing
  backing store (avoids a full backing-store realloc per completion blit).
- Localized; review-verified, existing tests guard behavior.
- Size: S.

## Phase 5 — Bounded preload window (PDF-4, minor)

### Step 5.1

- `usePdfVirtualization.ts`: `PRELOAD_ROOT_MARGIN` from
  `"100% 0px 100% 0px"` (±1 viewport height — ±2160 px at 4K) to a px
  constant, e.g. `"1200px 0px 1200px 0px"` ≈ one 1080p viewport: bounded
  at 4K, unchanged feel at smaller windows.
- Update the module comment and the "±1 viewport height" wording in
  `docs/pdf.md`.
- Size: S.

## Phase 6 — Zoom ceiling verification (PDF-1 follow-up, no change expected)

### Step 6.1

- With the cap live, `ZOOM_LEVELS` up to 2× at 4K is safe by construction:
  buffers stay capped, CSS absorbs the rest. Verify manually at zoom 200%:
  the text layer still aligns with the visible scale (`--scale-factor` is
  the CSS `scale`, independent of the render ratio by design). Fix only if
  selection rects drift.
- Size: S (verification + possible small fix).

## Phase 7 — EPUB (EPUB-1/2) — measure, then decide

### Step 7.1 — Measurement spike only

- Paginated turns are discrete, so this is the EPUB item to measure before
  touching anything: at 4K, use the Phase 0 instrumentation pattern
  (turn-to-turn paint timing) plus Sysprof marks (WebKitGTK ≥ 2.50) to
  attribute per-turn raster. Scrolled flow is WebKitGTK tile production —
  relocation debounce is already correct upstream (PERF-7, vendored
  paginator stays untouched).
- Output: numbers + a product proposal (bounded max measure or 2-up spread
  at wide windows). **No paginator code changes in this phase** — it is an
  explicit exploration/product decision.
- Size: S spike; follow-up sized after data.

## Cross-cutting rules for every step

- Update `docs/performance.md` (Status column) in the same change as each
  budget it affects: PERF-11 → Step 0.1, PERF-1 → Step 1, PERF-3 → Step 2,
  PERF-4/PERF-6 → Step 3. The fix for a violation is a fix, never a raised
  threshold.
- Timing values are logged/measured manually only — E2E asserts
  deterministic `data-*` attributes exclusively (`docs/performance.md`
  rules section).
- Run `just check` per step; `just test-e2e` before merging Phases 1–3.
- Update `docs/pdf.md` rendering-policy text wherever behavior wording
  changes (cache keying, byte budget, preload margin).

## Dependencies

- Phase 2's numbers assume Phase 1's caps (capped buffers are what make
  192 MB ≈ 2–3 pages).
- Step 3.1 reuses Phase 1's policy module.
- Everything else is independent and can land in any order after its
  named dependency.
