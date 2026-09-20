/*
 * oracle.c
 *
 * Fidelity oracle for the Papers view-geometry port (ADR 0003).
 *
 * This harness drives the real GNOME Papers `PpsView` widget. It loads each
 * fixture through the poppler backend, sizes the view into a 1024x768
 * GtkScrolledWindow (the way the Papers shell hosts it), and runs a scripted
 * sequence of fit-mode changes, a scroll, and zoom in/out steps. After every
 * step it reads the observable geometry the TypeScript port must match:
 * integer page sizes, page extents, GtkAdjustment values, and the document
 * point under the viewport centre (the focal anchor).
 *
 * Test-only. Never built or shipped with TuxBooks. See oracle/README.md.
 *
 * Build: oracle/harness/build.sh
 * Run:   oracle/harness/build/oracle <fixtures-dir> [output.json]
 */

#include <gtk/gtk.h>
#include <locale.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#include "corpus.h"
#include "pps-document-factory.h"
#include "pps-init.h"
#include "pps-view-private.h"
#include "pps-view.h"

/* Pinned source of the widget under test. Also written into the output. */
#define ORACLE_PAPERS_COMMIT "dd693ee21726fdc08b135183e104b67c0e59b332"

/* pps-view.c pps_view_init sets priv->spacing = 12. The fallback harness used
 * 6, which is why its fit scales and page extents differ from this one. */
#define ORACLE_SPACING 12
#define ORACLE_VIEWPORT_WIDTH 1024
#define ORACLE_VIEWPORT_HEIGHT 768
#define ORACLE_ZOOM_FACTOR 1.2

static void
jnum (FILE *out, double value)
{
  if (fabs (value) < 5e-10)
    value = 0.0;
  fprintf (out, "%.9f", value);
}

static gboolean
quit_loop (gpointer data)
{
  g_main_loop_quit (data);
  return G_SOURCE_REMOVE;
}

static void
pump (void)
{
  GMainLoop *loop = g_main_loop_new (NULL, FALSE);

  g_timeout_add (250, quit_loop, loop);
  g_main_loop_run (loop);
  g_main_loop_unref (loop);
}

static char *
fixture_path (const char *fixtures_dir, const char *pdf)
{
  return g_canonicalize_filename (pdf, fixtures_dir);
}

static void
emit_adjustment (FILE *out, const char *name, GtkAdjustment *adjustment)
{
  fprintf (out, "\"%s\": {\"value\": ", name);
  jnum (out, gtk_adjustment_get_value (adjustment));
  fprintf (out, ", \"upper\": ");
  jnum (out, gtk_adjustment_get_upper (adjustment));
  fprintf (out, ", \"page_size\": ");
  jnum (out, gtk_adjustment_get_page_size (adjustment));
  fprintf (out, "}");
}

static void
emit_anchor (FILE *out, PpsView *view)
{
  PpsDocumentPoint *point;

  point = pps_view_get_document_point_for_view_point (
    view, ORACLE_VIEWPORT_WIDTH / 2.0, ORACLE_VIEWPORT_HEIGHT / 2.0);

  if (point == NULL) {
    fprintf (out, "null");
    return;
  }

  fprintf (out, "{\"page\": %d, \"x\": ", point->page_index);
  jnum (out, point->point_on_page.x);
  fprintf (out, ", \"y\": ");
  jnum (out, point->point_on_page.y);
  fprintf (out, "}");
  g_free (point);
}

/* Copy of the viewport-centre anchor so an anchor error can be measured
 * across a zoom step. */
typedef struct {
  gboolean valid;
  gint page;
  gdouble x;
  gdouble y;
} OracleAnchor;

static OracleAnchor
read_anchor (PpsView *view)
{
  OracleAnchor anchor = { FALSE, -1, 0.0, 0.0 };
  PpsDocumentPoint *point;

  point = pps_view_get_document_point_for_view_point (
    view, ORACLE_VIEWPORT_WIDTH / 2.0, ORACLE_VIEWPORT_HEIGHT / 2.0);
  if (point != NULL) {
    anchor.valid = TRUE;
    anchor.page = point->page_index;
    anchor.x = point->point_on_page.x;
    anchor.y = point->point_on_page.y;
    g_free (point);
  }

  return anchor;
}

static void
emit_anchor_error (FILE *out, const OracleAnchor *before,
                   const OracleAnchor *after)
{
  if (!before->valid || !after->valid || before->page != after->page) {
    fprintf (out, "null");
    return;
  }

  fprintf (out, "{\"dx\": ");
  jnum (out, after->x - before->x);
  fprintf (out, ", \"dy\": ");
  jnum (out, after->y - before->y);
  fprintf (out, "}");
}

static void
emit_fit_scales (FILE *out, PpsDocumentModel *model)
{
  static const PpsSizingMode modes[] = {
    PPS_SIZING_FIT_WIDTH,
    PPS_SIZING_FIT_PAGE,
    PPS_SIZING_AUTOMATIC,
  };
  static const char *names[] = { "fit_width", "fit_page", "automatic" };
  size_t i;

  fprintf (out, "\"fit_scales\": {");
  for (i = 0; i < G_N_ELEMENTS (modes); i++) {
    pps_document_model_set_sizing_mode (model, modes[i]);
    pump ();

    if (i > 0)
      fprintf (out, ", ");
    fprintf (out, "\"%s\": ", names[i]);
    jnum (out, pps_document_model_get_scale (model));
  }
  fprintf (out, "}");
}

static void
emit_page_sizes (FILE *out,
                 PpsDocument *document,
                 PpsDocumentModel *model,
                 double scale)
{
  int rotation = pps_document_model_get_rotation (model);
  int i;

  fprintf (out, "[");
  for (i = 0; i < pps_document_get_n_pages (document); i++) {
    int width, height;

    _get_page_size_for_scale_and_rotation (document, i, scale, rotation,
                                           &width, &height);
    if (i > 0)
      fprintf (out, ", ");
    fprintf (out, "{\"index\": %d, \"width\": %d, \"height\": %d}", i, width,
             height);
  }
  fprintf (out, "]");
}

static void
emit_page_extents (FILE *out,
                   PpsDocument *document,
                   PpsView *view)
{
  int i;

  fprintf (out, "[");
  for (i = 0; i < pps_document_get_n_pages (document); i++) {
    GdkRectangle area;

    pps_view_get_page_extents (view, i, &area);
    if (i > 0)
      fprintf (out, ", ");
    fprintf (out,
             "{\"index\": %d, \"x\": %d, \"y\": %d, \"width\": %d, "
             "\"height\": %d}",
             i, area.x, area.y, area.width, area.height);
  }
  fprintf (out, "]");
}

static void
emit_page_doc_sizes (FILE *out, PpsDocument *document)
{
  int i;

  fprintf (out, "[");
  for (i = 0; i < pps_document_get_n_pages (document); i++) {
    gdouble width, height;

    pps_document_get_page_size (document, i, &width, &height);
    if (i > 0)
      fprintf (out, ", ");
    fprintf (out, "{\"index\": %d, \"width\": ", i);
    jnum (out, width);
    fprintf (out, ", \"height\": ");
    jnum (out, height);
    fprintf (out, "}");
  }
  fprintf (out, "]");
}

static void
emit_point_mapping (FILE *out, PpsView *view)
{
  static const double fractions[] = { 0.1, 0.5, 0.9 };
  size_t xi, yi;
  int first = 1;

  fprintf (out, "[");
  for (yi = 0; yi < G_N_ELEMENTS (fractions); yi++) {
    for (xi = 0; xi < G_N_ELEMENTS (fractions); xi++) {
      double vx = fractions[xi] * ORACLE_VIEWPORT_WIDTH;
      double vy = fractions[yi] * ORACLE_VIEWPORT_HEIGHT;
      PpsDocumentPoint *point;

      point = pps_view_get_document_point_for_view_point (view, vx, vy);
      if (!first)
        fprintf (out, ", ");
      first = 0;
      fprintf (out, "{\"view_x\": ");
      jnum (out, vx);
      fprintf (out, ", \"view_y\": ");
      jnum (out, vy);
      fprintf (out, ", \"document_point\": ");
      if (point == NULL) {
        fprintf (out, "null");
      } else {
        fprintf (out, "{\"page\": %d, \"x\": ", point->page_index);
        jnum (out, point->point_on_page.x);
        fprintf (out, ", \"y\": ");
        jnum (out, point->point_on_page.y);
        fprintf (out, "}");
        g_free (point);
      }
      fprintf (out, "}");
    }
  }
  fprintf (out, "]");
}

static void
emit_script_step (FILE *out,
                  const char *action,
                  double factor,
                  PpsDocumentModel *model,
                  PpsView *view,
                  const OracleAnchor *anchor_before)
{
  GtkAdjustment *hadjustment =
    gtk_scrollable_get_hadjustment (GTK_SCROLLABLE (view));
  GtkAdjustment *vadjustment =
    gtk_scrollable_get_vadjustment (GTK_SCROLLABLE (view));
  OracleAnchor anchor_after = read_anchor (view);

  fprintf (out, "{\"action\": \"%s\", \"factor\": ", action);
  jnum (out, factor);
  fprintf (out, ", \"scale\": ");
  jnum (out, pps_document_model_get_scale (model));
  fprintf (out, ", ");
  emit_adjustment (out, "hadjustment", hadjustment);
  fprintf (out, ", ");
  emit_adjustment (out, "vadjustment", vadjustment);
  fprintf (out, ", \"center_anchor\": ");
  emit_anchor (out, view);
  fprintf (out, ", \"anchor_error\": ");
  emit_anchor_error (out, anchor_before, &anchor_after);
  fprintf (out, "}");
}

/* Drives the zoom policy: FREE sizing anchored at the fit-width scale, then
 * four 1.2 zoom-ins and three zoom-outs. Every step records the resulting
 * adjustment values and the document point held at the viewport centre. */
static void
emit_zoom_script (FILE *out,
                  PpsDocumentModel *model,
                  PpsView *view,
                  double fit_width)
{
  OracleAnchor anchor_before;
  int i;
  int first = 1;

  pps_document_model_set_sizing_mode (model, PPS_SIZING_FREE);
  pps_document_model_set_scale (model, fit_width);
  pump ();

  fprintf (out, "[");
  anchor_before = read_anchor (view);
  emit_script_step (out, "free_at_fit_width", 1.0, model, view,
                    &anchor_before);
  first = 0;

  for (i = 0; i < 4; i++) {
    if (!first)
      fprintf (out, ", ");
    first = 0;
    anchor_before = read_anchor (view);
    pps_view_zoom_in (view);
    pump ();
    emit_script_step (out, "zoom_in", ORACLE_ZOOM_FACTOR, model, view,
                      &anchor_before);
  }

  for (i = 0; i < 3; i++) {
    if (!first)
      fprintf (out, ", ");
    first = 0;
    anchor_before = read_anchor (view);
    pps_view_zoom_out (view);
    pump ();
    emit_script_step (out, "zoom_out", 1.0 / ORACLE_ZOOM_FACTOR, model, view,
                      &anchor_before);
  }

  fprintf (out, "]");
}

static int
load_fixture (const OracleFixture *fixture,
              const char *fixtures_dir,
              PpsDocument **out_document)
{
  g_autofree char *path = fixture_path (fixtures_dir, fixture->pdf);
  g_autofree char *uri = g_filename_to_uri (path, NULL, NULL);
  g_autoptr (GError) error = NULL;
  PpsDocument *document;

  document = pps_document_factory_get_document (uri, &error);
  if (document == NULL) {
    fprintf (stderr, "oracle: cannot open %s: %s\n", path,
             error ? error->message : "unknown error");
    return 1;
  }

  if (!pps_document_load (document, uri, &error)) {
    fprintf (stderr, "oracle: cannot load %s: %s\n", path,
             error ? error->message : "unknown error");
    g_object_unref (document);
    return 1;
  }

  pps_document_setup_cache (document);

  if (pps_document_get_n_pages (document) != fixture->page_count) {
    fprintf (stderr, "oracle: %s has %d pages, corpus says %d\n", fixture->pdf,
             pps_document_get_n_pages (document), fixture->page_count);
    g_object_unref (document);
    return 1;
  }

  *out_document = document;
  return 0;
}

static PpsView *
make_view (PpsDocument *document,
           PpsDocumentModel **out_model,
           GtkWidget **out_window)
{
  PpsAnnotationModel *annotation_model = pps_annotation_model_new ();
  PpsDocumentModel *model =
    g_object_new (PPS_TYPE_DOCUMENT_MODEL, "annotation-model", annotation_model,
                  NULL);
  PpsUndoContext *undo_context;
  PpsAnnotationsContext *annotations_context;
  PpsView *view;
  GtkWidget *scroll;
  GtkWidget *window;

  g_object_unref (annotation_model);

  pps_document_model_set_continuous (model, TRUE);
  pps_document_model_set_page_layout (model, PPS_PAGE_LAYOUT_SINGLE);
  pps_document_model_set_sizing_mode (model, PPS_SIZING_FIT_WIDTH);

  view = pps_view_new ();
  pps_view_set_model (view, model);

  undo_context = pps_undo_context_new (model);
  annotations_context = pps_annotations_context_new (model, undo_context);
  pps_view_set_annotations_context (view, annotations_context);
  g_object_unref (undo_context);
  g_object_unref (annotations_context);

  pps_document_model_set_document (model, document);

  scroll = gtk_scrolled_window_new ();
  gtk_scrolled_window_set_child (GTK_SCROLLED_WINDOW (scroll),
                                 GTK_WIDGET (view));

  window = gtk_window_new ();
  gtk_window_set_default_size (GTK_WINDOW (window), ORACLE_VIEWPORT_WIDTH,
                               ORACLE_VIEWPORT_HEIGHT);
  gtk_window_set_child (GTK_WINDOW (window), scroll);
  gtk_window_present (GTK_WINDOW (window));
  pump ();

  *out_model = model;
  *out_window = window;
  return view;
}

static void
emit_fixture (FILE *out,
              const OracleFixture *fixture,
              const char *fixtures_dir,
              int last)
{
  g_autoptr (PpsDocument) document = NULL;
  PpsDocumentModel *model;
  PpsView *view;
  GtkWidget *window;
  double fit_width;

  if (load_fixture (fixture, fixtures_dir, &document) != 0)
    exit (1);

  view = make_view (document, &model, &window);

  fprintf (out, "  {\n");
  fprintf (out, "    \"name\": \"%s\",\n", fixture->name);
  fprintf (out, "    \"pdf\": \"%s\",\n", fixture->pdf);
  fprintf (out, "    \"page_count\": %d,\n",
           pps_document_get_n_pages (document));

  fprintf (out, "    \"page_doc_sizes\": ");
  emit_page_doc_sizes (out, document);
  fprintf (out, ",\n    ");
  emit_fit_scales (out, model);
  fprintf (out, ",\n    ");

  fit_width = pps_document_model_get_scale (model);
  fprintf (out, "\"page_sizes_fit_width\": ");
  emit_page_sizes (out, document, model, fit_width);
  fprintf (out, ",\n    \"page_extents_fit_width\": ");
  emit_page_extents (out, document, view);
  fprintf (out, ",\n    \"point_mapping_fit_width\": ");
  emit_point_mapping (out, view);
  fprintf (out, ",\n    \"zoom_script\": ");
  emit_zoom_script (out, model, view, fit_width);
  fprintf (out, "\n  }%s\n", last ? "" : ",");

  /* The scrolled window sunk the view's floating reference, so only the
   * window and our own model reference are ours to release. */
  gtk_window_destroy (GTK_WINDOW (window));
  g_object_unref (model);
  pump ();
}

int
main (int argc, char **argv)
{
  FILE *out = stdout;
  const char *fixtures_dir;
  const char *backend_dir;
  int i;

  setlocale (LC_ALL, "C");

  if (argc < 2) {
    fprintf (stderr, "usage: %s <fixtures-dir> [output.json]\n", argv[0]);
    return 1;
  }
  fixtures_dir = argv[1];
  if (argc > 2) {
    out = fopen (argv[2], "w");
    if (!out) {
      fprintf (stderr, "oracle: cannot open %s\n", argv[2]);
      return 1;
    }
  }

  backend_dir = g_getenv ("PPS_BACKENDS_DIR");
  if (backend_dir == NULL) {
    fprintf (stderr, "oracle: PPS_BACKENDS_DIR is not set\n");
    return 1;
  }

  gtk_init ();

  if (!pps_init ()) {
    fprintf (stderr, "oracle: no Papers backends found in %s\n", backend_dir);
    return 1;
  }

  fprintf (out, "{\n");
  fprintf (out, "  \"schema\": \"tuxbooks.papers-oracle/2\",\n");
  fprintf (out, "  \"papers_commit\": \"%s\",\n", ORACLE_PAPERS_COMMIT);
  fprintf (out, "  \"harness\": \"pps_view_gtk\",\n");
  fprintf (out, "  \"viewport\": {\"width\": %d, \"height\": %d},\n",
           ORACLE_VIEWPORT_WIDTH, ORACLE_VIEWPORT_HEIGHT);
  fprintf (out, "  \"spacing\": %d,\n", ORACLE_SPACING);
  fprintf (out, "  \"documents\": [\n");

  for (i = 0; i < ORACLE_CORPUS_COUNT; i++)
    emit_fixture (out, &oracle_corpus[i], fixtures_dir,
                  i == ORACLE_CORPUS_COUNT - 1);

  fprintf (out, "  ]\n}\n");

  if (out != stdout)
    fclose (out);

  return 0;
}
