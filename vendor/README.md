# vendor

Reference-only sources pinned for reading, never for building.

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
