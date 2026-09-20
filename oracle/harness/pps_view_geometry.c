/*
 * pps_view_geometry.c
 *
 * Test-only extraction of the view geometry from GNOME Papers' PpsView.
 *
 * Origin: vendor/papers (tuxbooks/papers) at commit
 * dd693ee21726fdc08b135183e104b67c0e59b332, file libview/pps-view.c.
 * Copyright the Papers authors. GPL-2.0-or-later.
 *
 * Each function names the upstream symbol and the line it was taken from.
 * The bodies keep the upstream arithmetic; only the surrounding PpsView and
 * GtkAdjustment plumbing is replaced with the plain structs in the header.
 * Behaviour deliberately not reproduced is called out inline.
 */

#include "pps_view_geometry.h"

#include <math.h>
#include <stddef.h>

#define ORACLE_MIN(a, b) ((a) < (b) ? (a) : (b))
#define ORACLE_MAX(a, b) ((a) > (b) ? (a) : (b))
#define ORACLE_CLAMP(x, low, high) \
  ((x) > (high) ? (high) : ((x) < (low) ? (low) : (x)))

/* pps-view.c:6726 zoom_for_size_fit_width */
double
oracle_zoom_for_size_fit_width (double doc_width,
                                double doc_height,
                                int target_width,
                                int target_height)
{
  (void) doc_height;
  (void) target_height;
  return (double) target_width / doc_width;
}

/* pps-view.c:6735 zoom_for_size_fit_height */
double
oracle_zoom_for_size_fit_height (double doc_width,
                                 double doc_height,
                                 int target_width,
                                 int target_height)
{
  (void) doc_width;
  (void) target_width;
  return (double) target_height / doc_height;
}

/* pps-view.c:6744 zoom_for_size_fit_page */
double
oracle_zoom_for_size_fit_page (double doc_width,
                               double doc_height,
                               int target_width,
                               int target_height)
{
  double w_scale;
  double h_scale;

  w_scale = (double) target_width / doc_width;
  h_scale = (double) target_height / doc_height;

  return ORACLE_MIN (w_scale, h_scale);
}

/* pps-view.c:6759 zoom_for_size_automatic
 * The upstream GtkWidget argument is unused. */
double
oracle_zoom_for_size_automatic (double doc_width,
                                double doc_height,
                                int target_width,
                                int target_height)
{
  double fit_width_scale;
  double scale;

  fit_width_scale = oracle_zoom_for_size_fit_width (doc_width, doc_height,
                                                    target_width, target_height);

  if (doc_height < doc_width) {
    double fit_height_scale;

    fit_height_scale = oracle_zoom_for_size_fit_height (doc_width, doc_height,
                                                        target_width, target_height);
    scale = ORACLE_MIN (fit_width_scale, fit_height_scale);
  } else {
    scale = fit_width_scale;
  }

  return scale;
}

static void
oracle_get_max_page_size (const OracleView *view,
                          double *max_width,
                          double *max_height)
{
  double w = 0.0;
  double h = 0.0;
  int i;

  for (i = 0; i < view->page_count; i++) {
    w = ORACLE_MAX (w, view->pages[i].width);
    h = ORACLE_MAX (h, view->pages[i].height);
  }

  if (max_width)
    *max_width = w;
  if (max_height)
    *max_height = h;
}

/* pps-view.c:6851 pps_view_zoom_for_size_continuous */
double
oracle_zoom_for_size_continuous (const OracleView *view,
                                 OracleSizingMode mode,
                                 int width,
                                 int height)
{
  double doc_width, doc_height;
  double scale;
  int rotation = view->rotation;

  oracle_get_max_page_size (view, &doc_width, &doc_height);
  if (rotation == 90 || rotation == 270) {
    double tmp;

    tmp = doc_width;
    doc_width = doc_height;
    doc_height = tmp;
  }

  width -= 2 * view->spacing;
  height -= 2 * view->spacing;

  switch (mode) {
  case ORACLE_SIZING_FIT_WIDTH:
    scale = oracle_zoom_for_size_fit_width (doc_width, doc_height, width, height);
    break;
  case ORACLE_SIZING_FIT_PAGE:
    scale = oracle_zoom_for_size_fit_page (doc_width, doc_height, width, height);
    break;
  case ORACLE_SIZING_AUTOMATIC:
    scale = oracle_zoom_for_size_automatic (doc_width, doc_height, width, height);
    break;
  default:
    scale = 1.0;
    break;
  }

  return scale;
}

/* pps-view.c:1186 _get_page_size_for_scale_and_rotation */
void
oracle_get_page_size_for_scale_and_rotation (const OracleView *view,
                                             int page,
                                             int *page_width,
                                             int *page_height)
{
  double w, h;
  int width, height;

  w = view->pages[page].width;
  h = view->pages[page].height;

  width = (int) (w * view->scale + 0.5);
  height = (int) (h * view->scale + 0.5);

  if (page_width)
    *page_width = (view->rotation == 0 || view->rotation == 180) ? width : height;
  if (page_height)
    *page_height = (view->rotation == 0 || view->rotation == 180) ? height : width;
}

/* pps-view.c:1361 get_doc_page_size (rotation applied) */
void
oracle_get_doc_page_size (const OracleView *view,
                          int page,
                          double *width,
                          double *height)
{
  double w, h;

  w = view->pages[page].width;
  h = view->pages[page].height;

  if (view->rotation == 0 || view->rotation == 180) {
    if (width)
      *width = w;
    if (height)
      *height = h;
  } else {
    if (width)
      *width = h;
    if (height)
      *height = w;
  }
}

static int
oracle_is_page_size_uniform (const OracleView *view)
{
  int i;

  for (i = 1; i < view->page_count; i++) {
    if (view->pages[i].width != view->pages[0].width ||
        view->pages[i].height != view->pages[0].height)
      return 0;
  }

  return 1;
}

/* pps-view.c:255 pps_view_build_height_to_page_cache, height_to_page only.
 * The dual_height_to_page half is omitted because dual page layout is out of
 * scope for the first port. */
void
oracle_build_height_to_page_cache (const OracleView *view,
                                   double *height_to_page)
{
  int swap;
  int uniform;
  int i;
  double uniform_height;
  double page_height;
  double saved_height;
  double u_width = 0.0, u_height = 0.0;
  int n_pages = view->page_count;

  swap = (view->rotation == 90 || view->rotation == 270);

  uniform = oracle_is_page_size_uniform (view);

  if (uniform) {
    u_width = view->pages[0].width;
    u_height = view->pages[0].height;
  }

  saved_height = 0;
  for (i = 0; i <= n_pages; i++) {
    if (uniform) {
      uniform_height = swap ? u_width : u_height;
      height_to_page[i] = i * uniform_height;
    } else {
      if (i < n_pages) {
        double w, h;

        w = view->pages[i].width;
        h = view->pages[i].height;
        page_height = swap ? w : h;
      } else {
        page_height = 0;
      }
      height_to_page[i] = saved_height;
      saved_height += page_height;
    }
  }
}

/* pps-view.c:380 pps_view_get_height_to_page, single-page branch, plus
 * get_page_y_offset's non-dual offset at pps-view.c:1244. */
int
oracle_get_page_y_offset (const OracleView *view,
                          const double *height_to_page,
                          int page)
{
  double h = height_to_page[page];
  int offset;

  offset = (int) (h * view->scale + 0.5);
  offset += (page + 1) * view->spacing;

  return offset;
}

/* pps-view.c:3310 pps_view_size_request_continuous height:
 * get_page_y_offset for the sentinel page n_pages. Fit modes use a requisition
 * width of 1 (pps-view.c:3344 to 3350); free mode uses the content width. */
int
oracle_size_request_height (const OracleView *view,
                            const double *height_to_page)
{
  return oracle_get_page_y_offset (view, height_to_page, view->page_count);
}

/* pps-view.c:1265 pps_view_get_page_extents, continuous single-page branch. */
void
oracle_get_page_extents (const OracleView *view,
                         const double *height_to_page,
                         int page,
                         int *x,
                         int *y,
                         int *width,
                         int *height)
{
  int page_width, page_height;

  oracle_get_page_size_for_scale_and_rotation (view, page, &page_width, &page_height);
  *width = page_width;
  *height = page_height;

  *x = view->spacing;
  *x = *x + ORACLE_MAX (0, view->widget_width - (page_width + view->spacing * 2)) / 2;
  *y = oracle_get_page_y_offset (view, height_to_page, page);
}

/* Mirrors gtk_adjustment_configure: values clamp to [lower, upper - page_size].
 * Verified against GTK 4.22 on this machine; see oracle/README.md. */
double
oracle_adjustment_configure (OracleAdjustment *adjustment,
                             double value,
                             double lower,
                             double upper,
                             double page_size)
{
  double max_value = upper - page_size;

  if (max_value < lower)
    max_value = lower;

  adjustment->lower = lower;
  adjustment->upper = upper;
  adjustment->page_size = page_size;
  adjustment->value = ORACLE_CLAMP (value, lower, max_value);

  return adjustment->value;
}

/* pps-view.c:564 pps_view_update_adjustment_value.
 * The scroll-animation guard in the SCROLL_TO_KEEP_POSITION branch only holds
 * a value during an in-flight scroll animation; a scripted oracle has none, so
 * it is not reproduced. */
double
oracle_update_adjustment_value (OracleAdjustment *adjustment,
                                OracleScrollMode pending_scroll,
                                double zoom_center,
                                int alloc_size,
                                int req_size)
{
  double page_size, value, new_value, upper, factor;

  factor = 1.0;
  value = adjustment->value;
  upper = adjustment->upper;
  page_size = adjustment->page_size;

  if (zoom_center < 0)
    zoom_center = page_size * 0.5;

  if (upper != 0.0) {
    switch (pending_scroll) {
    case ORACLE_SCROLL_TO_KEEP_POSITION:
      factor = value / upper;
      break;
    case ORACLE_SCROLL_TO_CENTER:
      factor = (value + zoom_center) / upper;
      break;
    }
  }

  upper = ORACLE_MAX (alloc_size, req_size);
  page_size = alloc_size;

  switch (pending_scroll) {
  case ORACLE_SCROLL_TO_KEEP_POSITION:
    new_value = ORACLE_CLAMP (upper * factor, 0, upper - page_size);
    break;
  case ORACLE_SCROLL_TO_CENTER:
    new_value = ORACLE_CLAMP (upper * factor - zoom_center, 0, upper - page_size);
    break;
  default:
    new_value = value;
    break;
  }

  return oracle_adjustment_configure (adjustment, new_value, 0, upper,
                                      page_size);
}

/* pps-view.c:1401 pps_view_get_point_on_page.
 * Upstream reads the document page size of priv->current_page rather than
 * @page_index; the harness passes the page it is mapping, which is the same
 * page. */
void
oracle_get_point_on_page (const OracleView *view,
                          const double *height_to_page,
                          int page,
                          double scroll_x,
                          double scroll_y,
                          double view_x,
                          double view_y,
                          double *x,
                          double *y)
{
  int area_x, area_y, area_w, area_h;
  double raw_w, raw_h, sx, sy;

  view_x += scroll_x;
  view_y += scroll_y;

  oracle_get_page_extents (view, height_to_page, page, &area_x, &area_y,
                           &area_w, &area_h);

  sx = ORACLE_MAX ((view_x - (double) area_x) / view->scale, 0);
  sy = ORACLE_MAX ((view_y - (double) area_y) / view->scale, 0);

  raw_w = view->pages[page].width;
  raw_h = view->pages[page].height;

  switch (view->rotation) {
  case 0:
    *x = sx;
    *y = sy;
    break;
  case 90:
    *x = sy;
    *y = raw_h - sx;
    break;
  case 180:
    *x = raw_w - sx;
    *y = raw_h - sy;
    break;
  case 270:
    *x = raw_w - sy;
    *y = sx;
    break;
  default:
    *x = sx;
    *y = sy;
    break;
  }
}

/* pps-view.c:1503 transform_page_point_by_rotation_scale, plus
 * pps_view:1554 transform_page_point_to_view_point. */
void
oracle_transform_page_point_to_view_point (const OracleView *view,
                                           const double *height_to_page,
                                           int page,
                                           double x,
                                           double y,
                                           double *view_x,
                                           double *view_y)
{
  int area_x, area_y, area_w, area_h;
  double sx, sy, out_x, out_y;

  switch (view->rotation) {
  case 0:
    sx = x;
    sy = y;
    break;
  case 90: {
    double width;

    oracle_get_doc_page_size (view, page, &width, NULL);
    sx = width - y;
    sy = x;
  } break;
  case 180: {
    double width, height;

    oracle_get_doc_page_size (view, page, &width, &height);
    sx = width - x;
    sy = height - y;
  } break;
  case 270: {
    double height;

    oracle_get_doc_page_size (view, page, NULL, &height);
    sx = y;
    sy = height - x;
  } break;
  default:
    sx = x;
    sy = y;
    break;
  }

  oracle_get_page_extents (view, height_to_page, page, &area_x, &area_y,
                           &area_w, &area_h);

  out_x = ORACLE_CLAMP ((int) (sx * view->scale + 0.5), 0, area_w);
  out_y = ORACLE_CLAMP ((int) (sy * view->scale + 0.5), 0, area_h);

  *view_x = out_x + area_x;
  *view_y = out_y + area_y;
}
