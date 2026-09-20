/*
 * pps_view_geometry.h
 *
 * Test-only extraction of the view geometry from GNOME Papers' PpsView.
 *
 * Origin: vendor/papers (tuxbooks/papers) at commit
 * dd693ee21726fdc08b135183e104b67c0e59b332, file libview/pps-view.c.
 * Copyright the Papers authors. GPL-2.0-or-later.
 *
 * This is the sanctioned ADR 0003 fallback: building all of Papers with GTK
 * needs system packages this environment does not have, so the pure geometry
 * functions are compiled into a standalone native harness instead. Nothing
 * here is built or shipped with TuxBooks. See oracle/README.md.
 */

#ifndef ORACLE_PPS_VIEW_GEOMETRY_H
#define ORACLE_PPS_VIEW_GEOMETRY_H

typedef enum {
  ORACLE_SIZING_FIT_WIDTH = 0,
  ORACLE_SIZING_FIT_PAGE = 1,
  ORACLE_SIZING_AUTOMATIC = 2
} OracleSizingMode;

typedef enum {
  ORACLE_SCROLL_TO_KEEP_POSITION = 0,
  ORACLE_SCROLL_TO_CENTER = 1
} OracleScrollMode;

typedef struct {
  double width;
  double height;
} OraclePageSize;

/* The subset of PpsView state the geometry reads. Continuous scrolling,
 * single-page layout, rotation 0 or 180 are the only supported modes; dual
 * page layout is out of scope for the first port. */
typedef struct {
  const OraclePageSize *pages;
  int page_count;
  int rotation;
  int continuous;
  int spacing;
  double scale;
  int widget_width;
  int widget_height;
} OracleView;

/* Mirrors the GtkAdjustment fields pps_view_update_adjustment_value touches.
 * configure() applies the same clamp gtk_adjustment_configure does. */
typedef struct {
  double value;
  double lower;
  double upper;
  double page_size;
} OracleAdjustment;

double oracle_zoom_for_size_fit_width (double doc_width,
                                       double doc_height,
                                       int target_width,
                                       int target_height);
double oracle_zoom_for_size_fit_height (double doc_width,
                                        double doc_height,
                                        int target_width,
                                        int target_height);
double oracle_zoom_for_size_fit_page (double doc_width,
                                      double doc_height,
                                      int target_width,
                                      int target_height);
double oracle_zoom_for_size_automatic (double doc_width,
                                       double doc_height,
                                       int target_width,
                                       int target_height);
double oracle_zoom_for_size_continuous (const OracleView *view,
                                        OracleSizingMode mode,
                                        int width,
                                        int height);

void oracle_get_page_size_for_scale_and_rotation (const OracleView *view,
                                                  int page,
                                                  int *page_width,
                                                  int *page_height);
void oracle_get_doc_page_size (const OracleView *view,
                               int page,
                               double *width,
                               double *height);
void oracle_build_height_to_page_cache (const OracleView *view,
                                        double *height_to_page);
int oracle_get_page_y_offset (const OracleView *view,
                              const double *height_to_page,
                              int page);
int oracle_size_request_height (const OracleView *view,
                                const double *height_to_page);
void oracle_get_page_extents (const OracleView *view,
                              const double *height_to_page,
                              int page,
                              int *x,
                              int *y,
                              int *width,
                              int *height);

double oracle_adjustment_configure (OracleAdjustment *adjustment,
                                    double value,
                                    double lower,
                                    double upper,
                                    double page_size);
double oracle_update_adjustment_value (OracleAdjustment *adjustment,
                                       OracleScrollMode pending_scroll,
                                       double zoom_center,
                                       int alloc_size,
                                       int req_size);

void oracle_get_point_on_page (const OracleView *view,
                               const double *height_to_page,
                               int page,
                               double scroll_x,
                               double scroll_y,
                               double view_x,
                               double view_y,
                               double *x,
                               double *y);
void oracle_transform_page_point_to_view_point (const OracleView *view,
                                                const double *height_to_page,
                                                int page,
                                                double x,
                                                double y,
                                                double *view_x,
                                                double *view_y);

#endif /* ORACLE_PPS_VIEW_GEOMETRY_H */
