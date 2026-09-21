# PDF view behaviour

TuxBooks' PDF reader reproduces the zoom and layout behaviour of GNOME Papers,
mapped onto the existing reader architecture. This document is the extracted
specification: what the behaviour is, where it comes from in Papers, and where
it lands in TuxBooks. The engine is PDFium (ADR 0002); this layer is
engine-agnostic (ADR 0003).

Reference: `tuxbooks/papers` at commit `dd693ee`, upstream `GNOME/papers` v51.0.
All symbol and line references below are Papers names.

Where a rule in this document is marked **verify**, the Phase 0 spike confirms it
against the native oracle before it becomes a contract.

## Where it lands

| Concern                    | Papers source                                       | TuxBooks module                              |
| -------------------------- | --------------------------------------------------- | -------------------------------------------- |
| Fit formulas               | `libview/pps-view.c` `zoom_for_size_*`              | `lib/pdf/pdfLayout.ts`                       |
| Layout modes, page extents | `pps-view.c` `pps_view_get_page_extents`, etc.      | `lib/pdf/pdfLayout.ts`                       |
| Focal zoom, scroll policy  | `pps-view.c` `pps_view_update_adjustment_value`     | `usePdfScale`, `usePdfScrollTracking`        |
| Integer page sizing        | `libdocument/pps-render-context.c` `compute_scales` | `lib/pdf/pdfLayout.ts`, `pdfRenderPolicy.ts` |
| Smooth zoom                | `libview/pps-view-page.c` snapshot                  | `components/reader/pdf/PdfPageCanvas.tsx`    |
| Preload and cache budget   | `libview/pps-pixbuf-cache.c`                        | `lib/pdf/pdfBitmapCache.ts`                  |

## Layout modes

Papers separates two axes. Page layout is `SINGLE`, `DUAL`, or `AUTOMATIC`.
Sizing is `FIT_PAGE`, `FIT_WIDTH`, `FREE`, or `AUTOMATIC`
(`libview/context/pps-document-model.h`). Continuous scrolling is a separate
boolean (`pps-view.c` `pps_view_size_allocate`). Page extents are computed in
`pps_view_get_page_extents` (`pps-view.c:1265`), with the per-page offset from
`get_page_y_offset` (`pps-view.c:1244`) and the scaled page size from
`_get_page_size_for_scale_and_rotation` (`pps-view.c:1186`).

TuxBooks today has fit width, fit page, and automatic fit, all continuous. The
first version keeps those and does not add dual-page layout. Dual page is a
later addition, and it is not on the critical path for zoom feel.

## Fit formulas

From `pps-view.c`:

- fit width is `target_width / doc_width` (`zoom_for_size_fit_width:6726`);
- fit height is `target_height / doc_height` (`zoom_for_size_fit_height:6735`);
- fit page is `MIN(width_scale, height_scale)` (`zoom_for_size_fit_page:6744`);
- automatic is `zoom_for_size_automatic` (`:6759`): fit the width, except for
  a landscape page (`doc_height < doc_width`), where the lesser of the width
  and height scales wins. Verified against the oracle fixtures.

Mode dispatch is `pps_view_zoom_for_size` (`:6944`) with continuous and
dual-page variants (`:6783` onward), called from `pps_view_size_allocate`
(`:3463`). TuxBooks already implements the first three in
`pdfLayout.computePdfScale`; the port aligns the arithmetic, including the
rounding below, and keeps the existing mode names.

The target extent reserves `priv->spacing` on each side, so at the oracle's
1024×768 viewport with `spacing = 12` the fit width is `(1024 - 2*12) /
doc_width`. `PdfReader` sets the fit reference to the document's largest page
(`pps_document_get_max_page_size`), not page 1, so a mixed-size document fits
its widest and tallest page; `usePdfScale` passes the Papers spacing to
`computePdfScale`.

## Integer page sizing

A scaled page is rounded to whole pixels: `(int)(points * scale + 0.5)` in
`libdocument/pps-render-context.c` `pps_render_context_compute_scaled_size`
(`:112` to `:195`). The rounding is what stops page edges shimmering during a
zoom, because a half-pixel page size changes which pixels the compositor
touches on each step. TuxBooks' layout math must round the same way before it
computes scroll offsets.

## Focal-point zoom

This is the core of the Papers feel. On a zoom gesture the pointer position is
captured into `priv->zoom_center_x/y` and the pending scroll becomes
`SCROLL_TO_CENTER` (`pps-view.c:3556` to `:3569` for Ctrl+scroll, `:5963` for
pinch). When the adjustment updates, Papers computes where the document point
sits in the old extent and places it at the same screen position in the new
extent:

```
factor = (value + zoom_center) / upper
new_value = CLAMP(upper * factor - zoom_center, 0, upper - page_size)
```

(`pps_view_update_adjustment_value`, `pps-view.c:564`, with the replacement at
`:597` to `:598` and `:614` to `:615`.)

`pdfLayout.centerValue` is the port of that transform, and
`viewportPointToDocumentPoint` maps a viewport position back to a page point so
the oracle's `center_anchor` can be compared directly. The adjustment is
`value + zoom_center` over the old `upper`, reapplied to the new `MAX(viewport,
content)` and clamped, exactly as the C does.

TuxBooks currently re-anchors by the reading anchor's in-page fraction on a
scale change (`docs/PDF.md`). The port replaces that for pointer zooms with the
focal-anchor transform above. Keyboard and toolbar zooms keep the reading anchor,
because there is no pointer to anchor to.

## Scroll-preservation policy

Papers picks between two policies:

- `SCROLL_TO_KEEP_POSITION` preserves the relative scroll fraction and is set
  during a normal re-layout (`pps-view.c:3487`);
- `SCROLL_TO_CENTER` holds the focal anchor and is set by an explicit zoom.

`pdfLayout.keepPositionValue` is the `SCROLL_TO_KEEP_POSITION` branch and
`pdfLayout.centerValue` the `SCROLL_TO_CENTER` branch; `adjustmentValueForPolicy`
selects between them. Both read the paper's `upper = MAX(viewport, content)`
(`adjustmentUpper`).

Two helpers, `keep_scroll_of_current_page` and `needs_scrolling_to_current_page`,
stop the view from fighting a user during kinetic scroll
(`pps_view_adjustment_to_page_position:525`, `scroll_to_view_point:482`). TuxBooks
has no kinetic scroll model, so the port keeps the policy switch and drops the
scroll-fight helpers.

## Zoom stepping

Papers steps by a fixed factor, `ZOOM_IN_FACTOR` 1.2 (`pps-view.c:88`), through
`pps_view_zoom_in` and `pps_view_zoom_out` (`:6695` to `:6722`). TuxBooks snaps
to a preset ladder (`ZOOM_PRESETS`, Okular's `kZoomValues`). Keep the preset
ladder; it is a superset of the Papers behaviour and users already have muscle
memory for it. **Verify** that preset snapping still feels continuous once focal
anchoring is in place.

## Page to position mapping

The mapping functions to port or match:

- `get_scroll_offset` (`pps-view.c:840`);
- `pps_view_adjustment_to_page_position` (`:525`);
- `pps_view_get_point_on_page` (`:1400`);
- `transform_page_point_by_rotation_scale` (`:1503`);
- `transform_page_point_to_view_point` (`:1554`);
- `_pps_view_transform_doc_rect_to_view_rect` (`:1570`);
- `find_page_at_location` (`:1628`).

TuxBooks already owns this mapping in `pdfLayout.ts` and `usePdfScrollTracking`.
The port aligns the point transforms so the oracle can compare them directly.

## Smooth zoom

Papers draws each visible page into its allocated rect from a cached
`GdkTexture` (`pps-view-page.c` `pps_view_page_snapshot:527`), snapping to
physical pixels with `GSK_RECT_SNAP_ROUND` and using `GSK_SCALING_FILTER_NEAREST`
when the texture already matches the area (`:495` to `:522` and `:569` to
`:588`). During a scale change the existing texture is drawn scaled into the new
rect while asynchronous render jobs (`PpsJobRenderTexture`) produce the
new-scale texture, which replaces it on completion. There is no blank frame
between the gesture and the new raster. This is the smoothness users notice.

TuxBooks invalidates canvases and the scale-keyed bitmap cache on a scale change
(`docs/PDF.md`), so it blanks and re-renders. The port adds the scale-and-swap
policy: keep painting the previous bitmap under a transform until the new-scale
render commits, then swap. This is the one net-new mechanism in the port.

Scale-and-swap lives in `PdfPageCanvas`, not in the bitmap cache. The canvas
keeps the last bitmap it presented and, when the scale changes, draws it under
a CSS transform sized to the new page box; the freshly rasterized buffer
replaces it in one atomic blit. The cache stays exact-scale keyed, so it never
serves a stale-scale bitmap. `PdfReader` supplies the second half: a zoom moves
the pages that held pixels into a display-only set, keeps their canvases
mounted, and admits at most `MAX_CONCURRENT_RENDERS` pages to the fresh raster,
so no page-sized render is queued for every previously rendered page at once.
A page outside that budget keeps its scaled bitmap until the render budget
reaches it.

## Rendering and caching, as background

Papers renders a page to a `cairo_image_surface_create` at `scale * device_scale`
and wraps the pixels in a `GdkTexture` (`libdocument/backend/pdf/pps-poppler.c`
`pdf_page_render:396`, `libdocument/pps-document-misc.c:59`). The pixbuf cache
holds rendered textures with a three-page preload and a 50 MB budget
(`pps-pixbuf-cache.c`, `MAX_PRELOADED_PAGES 3`,
`DEFAULT_PIXBUF_CACHE_SIZE 52428800`). TuxBooks keeps its own byte-budgeted
bitmap cache and preload window; the numbers differ and the port does not adopt
Papers'. The comparison matters only for the oracle fixtures.

## What TuxBooks does not adopt

- The per-page `GtkWidget`, `GdkTexture`, and GSK snapshot machinery.
- The kinetic-scroll gesture model and its scroll-fight helpers.
- Papers' pixbuf cache sizing and preload counts, which conflict with the
  existing `docs/PERFORMANCE.md` budgets.

## Open items for the Phase 0 spike

- Whether `FPDF_RenderPageBitmapWithMatrix` covers region rendering faithfully
  at every scale.
- The comparison tolerance for the oracle.
- Whether scale-and-swap can key off the existing bitmap cache variant field or
  needs a new one. Resolved: it keys off a per-canvas last-presented bitmap, so
  the scale-exact bitmap cache is untouched and no new cache field is needed.
