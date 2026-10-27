# vendor

Sources pinned as git submodules. `vendor/papers` is reference-only, kept for
reading; `vendor/pagecurl-gl` is a first-party build input (see below).

## vendor/papers

The GNOME Papers view source, kept at `vendor/papers` as a git submodule so the
view-geometry port (ADR 0003) can read `libview/pps-view.c` and its callers.

- Upstream: <https://github.com/tuxbooks/papers>, a fork of `GNOME/papers`.
- Pinned commit: `dd693ee21726fdc08b135183e104b67c0e59b332`, branch `tuxbooks`.
- Licence: GPL-2.0-or-later. Compatible with TuxBooks' GPL-3.0-or-later.
- Clone it with `git submodule update --init vendor/papers`.

The submodule is not a build input. No bundler, package manifest, Rust crate,
or Electron packaging config reads this tree, and no file from it ships in the
product. The fidelity oracle under `oracle/` reads the pinned commit as the
provenance for the geometry it extracts, but it does not link, compile, or
bundle the submodule into the app.

## vendor/pagecurl-gl

The pagecurl-gl page-curl library, a first-party MIT library developed for the
book-mode page turn (Stage 2 of the book-mode spec, behind the turn adapter
seam). Unlike `vendor/papers`, this submodule is a build input: the reader will
consume it through a source alias in development and a built distribution
before release.

- Upstream: <https://github.com/tuunanet/pagecurl-gl>.
- Pinned commit: `8b72c2607c47f8f54cbfb34b346f21dd50baa714`, branch `main`.
- Clone it with `git submodule update --init vendor/pagecurl-gl`.
- The engine, texture, and shader decisions it must honor are recorded in its
  `docs/research/tuxbooks-integration-findings.md`.
