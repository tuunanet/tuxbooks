# ADR 0002: PDFium-WASM replaces MuPDF as the PDF engine

Status: accepted
Gated on: Phase 0 spike `tuxbooks-koe.2` (pass) and the fidelity oracle `tuxbooks-koe.3`
Date: 2026-09-20
Decides: the PDF engine used by the reader
Relates to: ADR 0003, `docs/PDF-VIEW.md`

## Context

The Electron renderer rasterizes PDFs with MuPDF.js (`mupdf` 1.28.1, AGPL-3.0).
MuPDF's JS device binding hands native references to JS callbacks and expects
JavaScript GC to release them. In a worker the GC does not keep up, so the Smart
Dark recolor device corrupts MuPDF's heap. The reader carries a growing set of
guardrails against this: worker recycling every 180 Smart Dark renders
(`SMART_RENDER_RECYCLE_LIMIT`), a failure escape that swaps the worker on the
first `Unexpected mesh type` throw, per-argument manual release inside the device
callback, a transformed-image cache that destroys its own entries because the GC
will not, and heap-size breadcrumbs to catch the leak. Those guardrails are the
reason this work started, and they are technical debt that exists only because
of MuPDF's binding semantics.

Two more forces:

- License. MuPDF is AGPL-3.0. TuxBooks is GPL-3.0-or-later. GPL-3 section 13
  permits the combination in a non-network app, so license alone does not force
  a change, but the project prefers not to ship AGPL-only dependencies.
- Quality. The view behaviour in ADR 0003 needs an engine that can size a page,
  raster it at an arbitrary scale, and return text geometry. It does not need
  MuPDF.

## Decision

Replace MuPDF.js with PDFium compiled to WebAssembly.

PDFium's public API is a set of synchronous C functions that take no native
object into a JS callback. The failure class that produced the guardrails cannot
exist in that shape, so the guardrails are deleted rather than reimplemented.
PDFium also:

- is BSD-3-Clause, compatible with GPL-3.0-or-later;
- is already bundled natively in the sidecar for import-time cover rendering;
- exposes `FPDF_LoadCustomDocument` with `FPDF_FILEACCESS`, which keeps the
  range-backed open, so a document never crosses the bridge whole;
- exposes `FPDF_RenderPageBitmap` and `FPDF_RenderPageBitmapWithMatrix` for
  whole-page and region rasterization;
- exposes `FPDF_GetPageSizeByIndexF` and `FPDF_GetPageWidthF/HeightF` for page
  geometry;
- exposes a category-level `FPDF_COLORSCHEME` (path fill and stroke, text fill
  and stroke) for dark rendering.

## Considered options

- Poppler-WASM. This is the engine Papers itself uses, and it is GPL-2.0-or-later,
  so it matches the project licence. The WASM path is the problem: only Poppler
  core plus the Splash backend has a real Emscripten build (Emscripten's own
  test suite renders PDFs under wasm). The `poppler-glib` path Papers uses pulls
  in Cairo, Pango, GLib, and fontconfig, and no maintained WASM package covers
  that stack. `tuxbooks/poppler.wasm` is alpha and carries no visible build
  scripts. Kept as the fallback if the PDFium spike fails.
- Stay on MuPDF. Rejected. It keeps the defect class, the guardrail debt, and an
  AGPL-only dependency.
- Port Papers and GTK to WASM. Rejected. GTK4 has no viable WASM target (no
  display backend, no GIO or portal story), so the view layer cannot ship. See
  ADR 0003.

## Consequences

- Smart Dark loses object-level recoloring and scanned-image classification.
  `FPDF_COLORSCHEME` recolors by category, and `FPDF_CONVERT_FILL_TO_STROKE`
  keeps adjacent fills legible. This is an accepted degradation. `smartColors.ts`
  shrinks to a palette-to-color-scheme map, plus a CSS filter for scans whose
  classification is dropped in the first version.
- The reader keeps the existing engine seam. `frontend/src/lib/pdf/pdfEngine.ts`
  stays the only module that imports the engine package, and an import rule
  enforces that so engine-specific workarounds cannot leak into reader
  components again.
- The MuPDF guardrails are deleted as each replaced capability lands, never in a
  separate cleanup pass. The spec records the cleanup buckets.
- Native PDFium stays for import-time covers; the renderer uses PDFium-WASM.
  Same engine, two artifacts.
- Bundle size stays in the same range. A PDFium WASM package is roughly 6 to 11
  MB, near the MuPDF WASM bundle it replaces.

## Risks

- The chosen PDFium WASM package may expose an incomplete C API. The Phase 0
  spike confirms the capability floor before this ADR moves to accepted.
- Region rendering through `FPDF_RenderPageBitmapWithMatrix` may behave
  differently from MuPDF's clip. The spike measures it against the
  `docs/PERFORMANCE.md` budgets.
- If the spike trips any kill criterion, the engine decision reopens to
  Poppler-WASM.
