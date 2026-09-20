# Fidelity oracle

Test-only native harness that drives the real GNOME Papers `PpsView` widget and
emits reference geometry for the view port (ADR 0003). It never builds into the
app and never ships.

The oracle produces the page extents, `GtkAdjustment` values (scroll), and
anchor points the TypeScript view geometry must match. The output is committed
at `oracle/expected/geometry.json` and versioned with the harness.

## The harness

`oracle/harness/oracle.c` is a GTK4 program. For each fixture it loads the PDF
through the poppler backend, hosts a `PpsView` in a `GtkScrolledWindow` sized to
1024x768 (the way `shell/resources/pps-document-view.blp` hosts it), and runs a
fixed script:

1. switch through the fit modes (fit width, fit page, automatic) and read the
   scale `PpsView` computes;
2. at fit width, read every page's integer size and extent;
3. sample the page-to-position mapping at a grid of view points;
4. enter `FREE` sizing at the fit-width scale, then four `pps_view_zoom_in`
   steps and three `pps_view_zoom_out` steps, recording the adjustment values
   and the document point held at the viewport centre after each step.

`PpsView` is a GTK4 widget, so the run goes through `xvfb-run` headless.

## Building Papers

The earlier fallback existed because Papers would not configure here
(`exempi-2.0`, `blueprint-compiler`, no sudo). Those gaps are closed, so the
oracle now builds the pinned Papers at `vendor/papers` (commit `dd693ee2`) with
meson. `harness/build.sh` configures a test-only build and builds only:

| Target | Why |
| --- | --- |
| `libppsdocument-4.0` | document model and factory |
| `libppsview-4.0` | the `PpsView` widget under test |
| `libpdfdocument.so` | poppler PDF backend module |
| `org.gnome.Papers.PdfDocument.papers-backend` | backend desktop file the factory scans |

Everything else is disabled with meson options: `shell=false`,
`previewer=false`, `thumbnailer=false`, `nautilus=false`, `documentation=false`,
`user_doc=false`, `tests=false`, `file_tests=false`, `keyring=disabled`,
`spell_check=disabled`, `introspection=disabled`, `comics=disabled`,
`djvu=disabled`, `tiff=disabled`, `sysprof=disabled`,
`gtk_unix_print=disabled`. That skips the Rust shell and the introspection
build, which are the two that blocked earlier attempts.

Papers guards private geometry symbols with hidden visibility. The oracle reads
`pps_view_get_page_extents` and `_get_page_size_for_scale_and_rotation`, so the
test-only Papers build sets `-Dc_args=-fvisibility=default` to export them. The
product never links these libraries, and no target from `vendor/papers` enters
any TuxBooks build, bundler, or package manifest.

The build tree lives under `oracle/harness/build/papers-build/`, which is
git-ignored.

## Corpus

`fixtures/generate.py` writes both the PDF fixtures and the `corpus.h` the
harness compiles against, from one definition, so the fixture list cannot drift
from the PDFs.

| Fixture | Pages | Shape |
| --- | --- | --- |
| `single-page` | 1 | US Letter |
| `mixed-sizes` | 4 | Letter, A4, Legal, A5 |
| `portrait` | 3 | A4 portrait |
| `landscape` | 3 | A4 and Letter landscape |
| `thousand-pages` | 1000 | alternating Letter and A4, non-uniform |
| `scan` | 1 | Letter with an embedded grayscale image |
| `vector-heavy` | 1 | Letter with 600 vector line segments |

`fixtures/manifest.json` records each PDF's page sizes and SHA-256.

## Run

```
oracle/run.sh            # build Papers + harness, regenerate, fail on drift
oracle/run.sh --update   # rewrite oracle/expected/geometry.json
```

`run.sh` verifies the `vendor/papers` pin, builds, sets
`PPS_BACKENDS_DIR`, `LD_LIBRARY_PATH`, and `GSETTINGS_SCHEMA_DIR` into the
Papers build tree, and runs the harness under `xvfb-run`. The harness takes a
fixtures directory and an optional output path:

```
oracle/harness/build.sh
oracle/harness/build/oracle <fixtures-dir> [output.json]
```

Running the harness twice produces byte-identical JSON; `run.sh` fails if a
rebuild drifts from the committed file.

## Output

`oracle/expected/geometry.json` carries `schema:
"tuxbooks.papers-oracle/2"`, `harness: "pps_view_gtk"`, the pinned
`papers_commit`, the viewport, the widget `spacing` (12), and one entry per
fixture:

- `page_doc_sizes`: page sizes in points, read from the document;
- `fit_scales`: fit width, fit page, automatic, as computed by `PpsView`;
- `page_sizes_fit_width`: integer page sizes at the fit-width scale;
- `page_extents_fit_width`: `x`, `y`, `width`, `height` per page;
- `point_mapping_fit_width`: view point to document point at fit width;
- `zoom_script`: each fit-mode/scroll/zoom step as action, factor, scale, both
  `GtkAdjustment` triples (value, upper, page size), the viewport-centre
  document point, and its drift from the point before the step.

Numbers are fixed to nine decimals.

### Differences from the fallback

The fallback extracted the arithmetic into `harness/pps_view_geometry.c` and
drove it directly. This harness replaces it as the single authority; that file
is deleted. The results differ in two ways:

- **Spacing.** The fallback passed `spacing = 6`. The real `pps_view_init`
  (`libview/pps-view.c`) sets `priv->spacing = 12`. Every fit scale and page
  extent therefore changes: for `single-page` fit width is `1.633986928`
  (`(1024 - 2*12) / 612`) instead of the fallback's `1.653595`
  (`(1024 - 2*6) / 612`), and the page extent is `1000x1294` at `x=12` instead
  of `1012x1310` at `x=6`.
- **Adjustments and anchors.** The fallback emitted a synthetic 48-entry matrix
  of hand-computed transforms. The real harness drives `pps_view_zoom_in` and
  `pps_view_zoom_out` and records the actual adjustment values and the
  viewport-centre anchor, including its drift (under 1 point) caused by integer
  page sizing.

## Licence and provenance

The pinned Papers source is Copyright the Papers authors, GPL-2.0-or-later,
compatible with TuxBooks' GPL-3.0-or-later. `vendor/papers` is reference-only
and never enters the product build. See `vendor/README.md`.
