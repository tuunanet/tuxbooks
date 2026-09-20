#!/usr/bin/env bash
# Regenerate the fidelity-oracle JSON and check it against the committed copy.
#
#   oracle/run.sh            rebuild, regenerate, and fail if the output drifts
#                            from oracle/expected/geometry.json
#   oracle/run.sh --update   rewrite oracle/expected/geometry.json in place
#
# The harness is test-only: this script never touches the product build. It
# drives the real GNOME Papers PpsView widget, which needs a display, so the
# run goes through xvfb-run.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(git -C "$here" rev-parse --show-toplevel)"
builddir="$here/harness/build/papers-build"

pinned="dd693ee21726fdc08b135183e104b67c0e59b332"
actual="$(git -C "$root/vendor/papers" rev-parse HEAD 2>/dev/null || true)"
if [[ "$actual" != "$pinned" ]]; then
  echo "error: vendor/papers is at '${actual:-missing}', expected $pinned" >&2
  echo "run: git -C '$root' submodule update --init vendor/papers" >&2
  exit 1
fi

bash "$here/harness/build.sh"

if ! command -v xvfb-run >/dev/null; then
  echo "error: xvfb-run is required to run the GTK harness headless" >&2
  exit 1
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

export PPS_BACKENDS_DIR="$builddir/libdocument/backend"
export LD_LIBRARY_PATH="$builddir/libview:$builddir/libdocument${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export GSETTINGS_SCHEMA_DIR="$builddir/data"
export LC_ALL=C

xvfb-run -a "$here/harness/build/oracle" "$here/fixtures" "$tmp"

expected="$here/expected/geometry.json"
if [[ "${1:-}" == "--update" ]]; then
  install -m 0644 "$tmp" "$expected"
  echo "wrote $expected"
else
  if ! diff -u "$expected" "$tmp"; then
    echo "error: oracle output drifted from $expected" >&2
    echo "review the change, then run: oracle/run.sh --update" >&2
    exit 1
  fi
  echo "oracle output is deterministic and matches $expected"
fi
