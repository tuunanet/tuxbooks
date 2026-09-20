# Fidelity oracle

Test-only native harness that emits reference geometry for the Papers view port
(ADR 0003). It never builds into the app and never ships.

The oracle produces the page extents, adjustment values (scroll), and anchor
points the TypeScript view geometry must match. The output is committed at
`oracle/expected/geometry.json` and versioned with the harness.

## Fallback and why

ADR 0003 prefers a native program that drives the real GTK `PpsView`, with a
sanctioned fallback when building Papers with GTK is impractical. This
environment cannot build Papers:

```
$ meson setup /tmp/papers-build vendor/papers \
    -Dshell=false -Dpreviewer=false -Dthumbnailer=false -Dnautilus=false \
    -Ddocumentation=false -Duser_doc=false -Dtests=false -Dfile_tests=false \
    -Dkeyring=disabled -Dspell_check=disabled -Dintrospection=disabled \
    -Dcomics=disabled -Ddjvu=disabled -Dtiff=disabled -Dpdf=enabled
...
Run-time dependency exempi-2.0 found: NO (tried pkgconfig)

meson.build:169:13: ERROR: Dependency "exempi-2.0" not found, tried pkgconfig
```

`exempi-2.0` and `blueprint-compiler` are required at configure time and are
not installed; installing them needs interactive sudo, which is not available
here. So this oracle uses the fallback: the pure geometry functions are
extracted from `libview/pps-view.c` into `harness/pps_view_geometry.c` and
driven by a standalone C program.

Each extracted function names its upstream symbol and line. The pinned source
is `vendor/papers` at commit `dd693ee2`, verified by `run.sh`. The extraction
covers the continuous single-page path only, which is what the first port
implements; dual-page layout is out of scope.

## Corpus

`fixtures/generate.py` writes both the PDF fixtures and the `corpus.h` the
harness compiles against, from one definition, so page geometry cannot drift
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
oracle/run.sh            # rebuild, regenerate, fail on drift from expected/
oracle/run.sh --update   # rewrite oracle/expected/geometry.json
```

`build.sh` needs only a C compiler and libm. The harness takes an optional
output path and defaults to stdout:

```
oracle/harness/build.sh
oracle/harness/build/oracle /tmp/geometry.json
```

## Output

`oracle/expected/geometry.json` carries `schema:
"tuxbooks.papers-oracle/1"`, the pinned `papers_commit`, the viewport and
spacing, and one entry per fixture:

- `fit_scales`: fit width, fit page, automatic;
- `page_sizes_fit_width`: rounded page sizes at the fit-width scale;
- `page_extents_fit_width`: `x`, `y`, `width`, `height` per page;
- `adjustments`: focal (`scroll_to_center`) and keep-position transforms, each
  with the before and after `GtkAdjustment` values and the old and new anchor;
- `zoom_steps_in` and `zoom_steps_out`: the 1.2 step ladder;
- `point_mapping`: page-to-view and back, for round-trip checks.

Numbers are fixed to six decimals. `run.sh` fails if a rebuild drifts from the
committed file.

## Licence and provenance

The extracted geometry is Copyright the Papers authors, GPL-2.0-or-later,
compatible with TuxBooks' GPL-3.0-or-later. See `vendor/README.md`.
