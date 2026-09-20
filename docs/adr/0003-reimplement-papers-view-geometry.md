# ADR 0003: Reimplement Papers' view geometry instead of porting its GTK view

Status: accepted
Date: 2026-09-20
Decides: how the reader reproduces the GNOME Papers zoom and layout behaviour
Relates to: ADR 0002, `docs/PDF-VIEW.md`

## Context

GNOME Papers, formerly Evince, has a zoom and scroll feel that is better than
the current TuxBooks reader, and it is the target for the new viewing
experience. The natural instinct is to port `libview/pps-view.c` and reuse code
that already works. That file is a `GtkWidget` subclass. It depends on GDK
windows and input, GSK snapshotting (`GtkSnapshot`, `GSK_RECT_SNAP_ROUND`,
`GSK_SCALING_FILTER_NEAREST`), `GtkAdjustment`, gesture controllers, and one
`PpsViewPage` widget per visible page. GTK4 has no WASM display backend, so
there is no runtime to host the widget, and the TuxBooks reader is a React
surface, not a GTK window.

Licensing is not the blocker. Papers is GPL-2.0-or-later, which can be taken
under GPL-3.0 and combined with the rest of TuxBooks when files are copied.

## Decision

Do not port `pps-view.c`. Reimplement its view geometry in TypeScript, with the
source kept as a pinned reference, and graft the result onto the existing
TuxBooks reader architecture.

Keep the current reader machinery: geometry slots, render policy and byte
budgets, bitmap cache, scroll tracking, progress, and the engine seam from ADR
0002.

Port only the mathematics and policies, taken from `pps-view.c`:

- the fit formulas: fit width, fit height, fit page, automatic;
- pointer-anchored focal zoom, which keeps the document point under the pointer
  fixed;
- the scroll-preservation modes: keep-position on re-layout, center on an
  explicit zoom;
- integer page sizing, which removes sub-pixel jitter;
- the smooth-zoom policy, which keeps the previous raster on screen under a
  scale transform while the new-scale raster renders, then swaps atomically.

Leave behind the GTK widget, `GdkTexture`, the GSK snap calls, and the
kinetic-scroll gesture model.

Fidelity is proven by a native oracle: a small Linux program that drives the
real `PpsView` and emits page extents, scroll values, and anchor points for a
fixture corpus. The TypeScript implementation must match it within tolerance. If
building Papers with GTK in CI proves impractical, the sanctioned fallback is to
compile the pure geometry functions out of `pps-view.c` into a test-only native
harness. That harness never enters the product.

## Considered options

- Full port of `pps-view.c` to WASM. Rejected. It requires GTK4 on WASM, which
  does not exist.
- Compile an extracted geometry core to WASM and call it from the reader.
  Rejected. It means forking and refactoring a GTK-coupled file, maintaining a
  `GtkAdjustment` stand-in, and tracking upstream, for a few hundred lines of
  arithmetic that TypeScript expresses directly and tests more cheaply.
- Reimplement without an oracle. Rejected. Without the native harness, fidelity
  to Papers is an opinion and cannot be tested.

## Consequences

- `docs/PDF-VIEW.md` becomes the written behaviour spec, with source references
  into Papers at commit `dd693ee`.
- The reader-contract tests stay engine-agnostic and gain a fake `PdfDocument`,
  so they survive the engine swap in ADR 0002 and any future one.
- The view geometry stays testable without a browser or an engine, which the
  current `pdfLayout.ts` pattern already supports.
- `tuxbooks/papers` is a reference-only submodule. It is not a build dependency
  and it never ships.
