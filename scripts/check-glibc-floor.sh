#!/usr/bin/env bash
# Assert that a packaged sidecar directory stays within the release glibc
# floor (docs/BUILD.md "Release sidecar ABI floor"). The deb and pacman gates
# share this check so the 2.35 ceiling has one implementation.
#
# Usage: check-glibc-floor.sh <sidecar-resources-dir> [label]
set -euo pipefail

GLIBC_MAX="2.35"
sidecar_dir="${1:?usage: check-glibc-floor.sh <sidecar-resources-dir> [label]}"
label="${2:-check-glibc-floor}"

fail() {
  echo "$label: FAIL: $*" >&2
  exit 1
}

command -v readelf >/dev/null 2>&1 ||
  fail "readelf is required for the glibc portability check (install binutils)"

for bin in tuxbooks tuxbooks-worker; do
  bin_path="$sidecar_dir/$bin"
  [ -f "$bin_path" ] || fail "missing packaged binary $bin_path"
  max_glibc="$(readelf --version-info "$bin_path" 2>/dev/null |
    grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sort -Vu | tail -n1 || true)"
  [ -n "$max_glibc" ] ||
    fail "no glibc version requirements found in $bin (unexpected; not a dynamic binary?)"
  if [ "$(printf '%s\n%s\n' "${max_glibc#GLIBC_}" "$GLIBC_MAX" | sort -V | tail -n1)" != "$GLIBC_MAX" ]; then
    objdump -T "$bin_path" | grep -- "$max_glibc" >&2 || true
    fail "$bin requires $max_glibc, above the GLIBC_$GLIBC_MAX floor (built against a newer glibc; use \`just sidecar-release\`; docs/BUILD.md)"
  fi
done

echo "$label: glibc floor OK (sidecar + worker <= GLIBC_$GLIBC_MAX)"
