#!/usr/bin/env bash
# Build the test-only fidelity oracle. Requires a C compiler and libm only.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fixtures="$(dirname "$here")/fixtures"
outdir="$here/build"

mkdir -p "$outdir"

cc="${CC:-cc}"
"$cc" -std=c11 -O2 -Wall -Wextra \
  -I"$here" -I"$fixtures" \
  "$here/oracle.c" "$here/pps_view_geometry.c" \
  -o "$outdir/oracle" -lm

echo "built $outdir/oracle"
