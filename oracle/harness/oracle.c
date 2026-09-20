/*
 * oracle.c
 *
 * Fidelity oracle for the Papers view-geometry port (ADR 0003).
 *
 * This is the sanctioned fallback: instead of driving a full GTK PpsView, it
 * drives the geometry extracted into pps_view_geometry.c and emits the same
 * observables (fit scales, integer page sizes, page extents, adjustment
 * values, anchor points) as JSON for the fixture corpus in
 * oracle/fixtures/corpus.h.
 *
 * Test-only. Never built or shipped with TuxBooks.
 *
 * Build: oracle/harness/build.sh
 * Run:   oracle/harness/build/oracle [output.json]
 */

#include "corpus.h"
#include "pps_view_geometry.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#define ORACLE_PAPERS_COMMIT "dd693ee21726fdc08b135183e104b67c0e59b332"
#define ORACLE_VIEWPORT_WIDTH 1024
#define ORACLE_VIEWPORT_HEIGHT 768
#define ORACLE_SPACING 6
#define ORACLE_ZOOM_FACTOR 1.2

static void
jnum (FILE *out, double value)
{
  if (fabs (value) < 5e-10)
    value = 0.0;
  fprintf (out, "%.6f", value);
}

static OracleView
view_for (const OracleFixture *fixture, double scale)
{
  OracleView view;

  view.pages = fixture->pages;
  view.page_count = fixture->page_count;
  view.rotation = 0;
  view.continuous = 1;
  view.spacing = ORACLE_SPACING;
  view.scale = scale;
  view.widget_width = ORACLE_VIEWPORT_WIDTH;
  view.widget_height = ORACLE_VIEWPORT_HEIGHT;

  return view;
}

static int
max_page_pixel_width (const OracleView *view)
{
  int max_width = 0;
  int i;

  for (i = 0; i < view->page_count; i++) {
    int width;

    oracle_get_page_size_for_scale_and_rotation (view, i, &width, NULL);
    if (width > max_width)
      max_width = width;
  }

  return max_width;
}

/* Requisition the way pps_view_size_request_continuous does it: fit modes
 * report width 1, free mode reports the content width; height is always the
 * content height. */
static int
requested_size (const OracleView *view,
                const double *height_to_page,
                int vertical,
                int free_mode)
{
  if (vertical)
    return oracle_size_request_height (view, height_to_page);

  if (!free_mode)
    return 1;

  return max_page_pixel_width (view) + view->spacing * 2;
}

static void
emit_fit_scales (FILE *out, const OracleFixture *fixture)
{
  static const OracleSizingMode modes[] = {
    ORACLE_SIZING_FIT_WIDTH,
    ORACLE_SIZING_FIT_PAGE,
    ORACLE_SIZING_AUTOMATIC,
  };
  static const char *names[] = { "fit_width", "fit_page", "automatic" };
  size_t i;

  fprintf (out, "\"fit_scales\": {");
  for (i = 0; i < sizeof (modes) / sizeof (modes[0]); i++) {
    OracleView view = view_for (fixture, 1.0);
    double scale;

    scale = oracle_zoom_for_size_continuous (&view, modes[i],
                                             ORACLE_VIEWPORT_WIDTH,
                                             ORACLE_VIEWPORT_HEIGHT);
    if (i > 0)
      fprintf (out, ", ");
    fprintf (out, "\"%s\": ", names[i]);
    jnum (out, scale);
  }
  fprintf (out, "}");
}

static void
emit_page_sizes (FILE *out, const OracleFixture *fixture, double scale)
{
  OracleView view = view_for (fixture, scale);
  int i;

  fprintf (out, "[");
  for (i = 0; i < fixture->page_count; i++) {
    int width, height;

    oracle_get_page_size_for_scale_and_rotation (&view, i, &width, &height);
    if (i > 0)
      fprintf (out, ", ");
    fprintf (out, "{\"index\": %d, \"width\": %d, \"height\": %d}", i, width,
             height);
  }
  fprintf (out, "]");
}

static void
emit_page_extents (FILE *out,
                   const OracleFixture *fixture,
                   const double *height_to_page,
                   double scale)
{
  OracleView view = view_for (fixture, scale);
  int i;

  fprintf (out, "[");
  for (i = 0; i < fixture->page_count; i++) {
    int x, y, width, height;

    oracle_get_page_extents (&view, height_to_page, i, &x, &y, &width, &height);
    if (i > 0)
      fprintf (out, ", ");
    fprintf (out, "{\"index\": %d, \"x\": %d, \"y\": %d, \"width\": %d, "
                  "\"height\": %d}",
             i, x, y, width, height);
  }
  fprintf (out, "]");
}

static void
emit_adjustment (FILE *out,
                 const OracleFixture *fixture,
                 const double *height_to_page,
                 const char *orientation,
                 int free_mode,
                 const char *mode,
                 OracleScrollMode pending_scroll,
                 double factor,
                 double value_fraction,
                 double zoom_center_fraction)
{
  OracleView before = view_for (fixture, 1.0);
  OracleView after = view_for (fixture, 1.0);
  OracleAdjustment adjustment;
  int vertical = (orientation[0] == 'v');
  int alloc = vertical ? ORACLE_VIEWPORT_HEIGHT : ORACLE_VIEWPORT_WIDTH;
  int req_before, req_after;
  double base_scale, zoom_center, anchor_old, anchor_new, new_value;
  double value_before;
  double fit_width, fit_page;

  fit_width = oracle_zoom_for_size_continuous (&before, ORACLE_SIZING_FIT_WIDTH,
                                               ORACLE_VIEWPORT_WIDTH,
                                               ORACLE_VIEWPORT_HEIGHT);
  fit_page = oracle_zoom_for_size_continuous (&before, ORACLE_SIZING_FIT_PAGE,
                                              ORACLE_VIEWPORT_WIDTH,
                                              ORACLE_VIEWPORT_HEIGHT);
  base_scale = free_mode ? fit_width * ORACLE_ZOOM_FACTOR : fit_page;
  before.scale = base_scale;
  after.scale = base_scale * factor;

  req_before = requested_size (&before, height_to_page, vertical, free_mode);
  req_after = requested_size (&after, height_to_page, vertical, free_mode);

  adjustment.lower = 0.0;
  adjustment.upper = (double) (alloc > req_before ? alloc : req_before);
  adjustment.page_size = (double) alloc;
  adjustment.value = value_fraction * (adjustment.upper - adjustment.page_size);
  if (adjustment.value < 0)
    adjustment.value = 0;

  value_before = adjustment.value;
  zoom_center = zoom_center_fraction * (double) alloc;
  anchor_old = value_before + zoom_center;

  new_value = oracle_update_adjustment_value (&adjustment, pending_scroll,
                                              zoom_center, alloc, req_after);
  anchor_new = new_value + zoom_center;

  fprintf (out,
           "{\"orientation\": \"%s\", \"context\": \"%s\", \"mode\": \"%s\", "
           "\"factor\": ",
           orientation, free_mode ? "free" : "fit", mode);
  jnum (out, factor);
  fprintf (out, ", \"value_fraction\": ");
  jnum (out, value_fraction);
  fprintf (out, ", \"zoom_center_fraction\": ");
  jnum (out, zoom_center_fraction);
  fprintf (out, ", \"before\": {\"value\": ");
  jnum (out, value_before);
  fprintf (out, ", \"upper\": ");
  jnum (out, (double) (alloc > req_before ? alloc : req_before));
  fprintf (out, ", \"page_size\": %d}, \"zoom_center\": ", alloc);
  jnum (out, zoom_center);
  fprintf (out, ", \"after\": {\"value\": ");
  jnum (out, new_value);
  fprintf (out, ", \"upper\": ");
  jnum (out, (double) (alloc > req_after ? alloc : req_after));
  fprintf (out, ", \"page_size\": %d}, \"anchor\": ", alloc);
  jnum (out, anchor_old);
  fprintf (out, ", \"new_anchor\": ");
  jnum (out, anchor_new);
  fprintf (out, "}");
}

static void
emit_adjustments (FILE *out,
                  const OracleFixture *fixture,
                  const double *height_to_page)
{
  static const double value_fractions[] = { 0.0, 0.5, 0.9 };
  static const double center_fractions[] = { 0.0, 0.5 };
  static const double factors[] = { ORACLE_ZOOM_FACTOR, 1.0 / ORACLE_ZOOM_FACTOR };
  static const char *orientations[] = { "horizontal", "vertical" };
  int first = 1;
  int oi, ctx, vi, ci, fi, k;

  fprintf (out, "\"adjustments\": [");
  for (oi = 0; oi < 2; oi++) {
    for (ctx = 0; ctx < 2; ctx++) {
      for (vi = 0; vi < 3; vi++) {
        for (ci = 0; ci < 2; ci++) {
          for (fi = 0; fi < 2; fi++) {
            for (k = 0; k < 2; k++) {
              if (!first)
                fprintf (out, ", ");
              first = 0;
              fprintf (out, "\n      ");
              emit_adjustment (
                out, fixture, height_to_page, orientations[oi], ctx,
                k == 0 ? "scroll_to_center" : "scroll_to_keep_position",
                k == 0 ? ORACLE_SCROLL_TO_CENTER
                       : ORACLE_SCROLL_TO_KEEP_POSITION,
                factors[fi], value_fractions[vi], center_fractions[ci]);
            }
          }
        }
      }
    }
  }
  fprintf (out, "\n    ]");
}

static void
emit_zoom_steps (FILE *out, const OracleFixture *fixture)
{
  OracleView base_view = view_for (fixture, 1.0);
  double base;
  int i;

  base = oracle_zoom_for_size_continuous (&base_view, ORACLE_SIZING_FIT_PAGE,
                                          ORACLE_VIEWPORT_WIDTH,
                                          ORACLE_VIEWPORT_HEIGHT);
  fprintf (out, "\"zoom_steps_in\": [");
  for (i = 1; i <= 4; i++) {
    OracleView view = view_for (fixture, base * pow (ORACLE_ZOOM_FACTOR, i));
    int width, height;

    oracle_get_page_size_for_scale_and_rotation (&view, 0, &width, &height);
    if (i > 1)
      fprintf (out, ", ");
    fprintf (out, "{\"steps\": %d, \"factor\": ", i);
    jnum (out, pow (ORACLE_ZOOM_FACTOR, i));
    fprintf (out, ", \"scale\": ");
    jnum (out, view.scale);
    fprintf (out, ", \"page_width\": %d, \"page_height\": %d}", width, height);
  }
  fprintf (out, "], \"zoom_steps_out\": [");
  for (i = 1; i <= 3; i++) {
    OracleView view = view_for (fixture, base * pow (1.0 / ORACLE_ZOOM_FACTOR, i));
    int width, height;

    oracle_get_page_size_for_scale_and_rotation (&view, 0, &width, &height);
    if (i > 1)
      fprintf (out, ", ");
    fprintf (out, "{\"steps\": %d, \"factor\": ", i);
    jnum (out, pow (1.0 / ORACLE_ZOOM_FACTOR, i));
    fprintf (out, ", \"scale\": ");
    jnum (out, view.scale);
    fprintf (out, ", \"page_width\": %d, \"page_height\": %d}", width, height);
  }
  fprintf (out, "]");
}

static void
emit_point_mapping (FILE *out,
                    const OracleFixture *fixture,
                    const double *height_to_page)
{
  static const double fractions[4][2] = {
    { 0.0, 0.0 },
    { 0.25, 0.25 },
    { 0.5, 0.5 },
    { 0.25, 0.75 },
  };
  double scale;
  OracleView base_view = view_for (fixture, 1.0);
  OracleView view;
  int i;

  scale = oracle_zoom_for_size_continuous (&base_view, ORACLE_SIZING_FIT_PAGE,
                                           ORACLE_VIEWPORT_WIDTH,
                                           ORACLE_VIEWPORT_HEIGHT);
  view = view_for (fixture, scale);

  fprintf (out, "\"point_mapping\": [");
  for (i = 0; i < 4; i++) {
    double px = fractions[i][0] * fixture->pages[0].width;
    double py = fractions[i][1] * fixture->pages[0].height;
    double vx, vy, rx, ry;

    oracle_transform_page_point_to_view_point (&view, height_to_page, 0, px, py,
                                               &vx, &vy);
    oracle_get_point_on_page (&view, height_to_page, 0, 0.0, 0.0, vx, vy, &rx,
                              &ry);
    if (i > 0)
      fprintf (out, ", ");
    fprintf (out, "{\"page\": 0, \"page_point\": {\"x\": ");
    jnum (out, px);
    fprintf (out, ", \"y\": ");
    jnum (out, py);
    fprintf (out, "}, \"view_point\": {\"x\": ");
    jnum (out, vx);
    fprintf (out, ", \"y\": ");
    jnum (out, vy);
    fprintf (out, "}, \"round_trip_page_point\": {\"x\": ");
    jnum (out, rx);
    fprintf (out, ", \"y\": ");
    jnum (out, ry);
    fprintf (out, "}}");
  }
  fprintf (out, "]");
}

static void
emit_fixture (FILE *out, const OracleFixture *fixture, int last)
{
  double *height_to_page;
  double fit_width;
  OracleView view;

  height_to_page = malloc (sizeof (double) * (fixture->page_count + 1));
  if (!height_to_page) {
    fprintf (stderr, "out of memory for %s\n", fixture->name);
    exit (1);
  }

  view = view_for (fixture, 1.0);
  oracle_build_height_to_page_cache (&view, height_to_page);
  fit_width = oracle_zoom_for_size_continuous (&view, ORACLE_SIZING_FIT_WIDTH,
                                               ORACLE_VIEWPORT_WIDTH,
                                               ORACLE_VIEWPORT_HEIGHT);

  fprintf (out, "  {\n");
  fprintf (out, "    \"name\": \"%s\",\n", fixture->name);
  fprintf (out, "    \"pdf\": \"%s\",\n", fixture->pdf);
  fprintf (out, "    \"page_count\": %d,\n", fixture->page_count);
  fprintf (out, "    ");
  emit_fit_scales (out, fixture);
  fprintf (out, ",\n    \"page_sizes_fit_width\": ");
  emit_page_sizes (out, fixture, fit_width);
  fprintf (out, ",\n    \"page_extents_fit_width\": ");
  emit_page_extents (out, fixture, height_to_page, fit_width);
  fprintf (out, ",\n    ");
  emit_adjustments (out, fixture, height_to_page);
  fprintf (out, ",\n    ");
  emit_zoom_steps (out, fixture);
  fprintf (out, ",\n    ");
  emit_point_mapping (out, fixture, height_to_page);
  fprintf (out, "\n  }%s\n", last ? "" : ",");

  free (height_to_page);
}

int
main (int argc, char **argv)
{
  FILE *out = stdout;
  int i;

  if (argc > 1) {
    out = fopen (argv[1], "w");
    if (!out) {
      fprintf (stderr, "cannot open %s\n", argv[1]);
      return 1;
    }
  }

  fprintf (out, "{\n");
  fprintf (out, "  \"schema\": \"tuxbooks.papers-oracle/1\",\n");
  fprintf (out, "  \"papers_commit\": \"%s\",\n", ORACLE_PAPERS_COMMIT);
  fprintf (out, "  \"harness\": \"fallback_extracted_geometry\",\n");
  fprintf (out, "  \"viewport\": {\"width\": %d, \"height\": %d},\n",
           ORACLE_VIEWPORT_WIDTH, ORACLE_VIEWPORT_HEIGHT);
  fprintf (out, "  \"spacing\": %d,\n", ORACLE_SPACING);
  fprintf (out, "  \"documents\": [\n");

  for (i = 0; i < ORACLE_CORPUS_COUNT; i++)
    emit_fixture (out, &oracle_corpus[i], i == ORACLE_CORPUS_COUNT - 1);

  fprintf (out, "  ]\n}\n");

  if (out != stdout)
    fclose (out);

  return 0;
}
