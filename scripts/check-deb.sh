#!/usr/bin/env bash
# Verify the Debian bundle produced by `pnpm tauri build --bundles deb`
# (run `just build` first). This is the packaging regression gate for
# milestone 11: the deb must be installable-by-strangers, so its control
# metadata must match tauri.conf.json, the desktop entry must be valid,
# the hicolor icons must be installed, and the bundled PDFium resource
# must be present (docs/release.md).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEB_DIR="$ROOT/src-tauri/target/release/bundle/deb"
CONF="$ROOT/src-tauri/tauri.conf.json"

shopt -s nullglob
declared_version="$(jq -r .version "$CONF")"
debs=("$DEB_DIR"/tuxbooks_"$declared_version"_*.deb)
shopt -u nullglob
if [ "${#debs[@]}" -ne 1 ]; then
  echo "check-deb: expected exactly one tuxbooks_${declared_version}_*.deb in $DEB_DIR, found ${#debs[@]}" >&2
  echo "check-deb: run \`just build\` first" >&2
  exit 1
fi
deb="${debs[0]}"

fail() {
  echo "check-deb: FAIL: $*" >&2
  exit 1
}

echo "check-deb: inspecting $(basename "$deb")"

# --- control metadata -----------------------------------------------------
package="$(dpkg-deb -f "$deb" Package)"
version="$(dpkg-deb -f "$deb" Version)"
arch="$(dpkg-deb -f "$deb" Architecture)"
depends="$(dpkg-deb -f "$deb" Depends)"
description="$(dpkg-deb -f "$deb" Description)"

[ "$package" = "tuxbooks" ] || fail "package name is $package, expected tuxbooks"
[ "$version" = "$declared_version" ] ||
  fail "deb version $version does not match tauri.conf.json $declared_version"
case "$arch" in
amd64 | arm64) ;;
*) fail "unexpected architecture $arch" ;;
esac
case "$depends" in
*libwebkit2gtk-4.1-0*) ;;
*) fail "missing runtime dependency libwebkit2gtk-4.1-0 (got: $depends)" ;;
esac
[ -n "$description" ] || fail "empty package description"

# --- payload --------------------------------------------------------------
payload="$(mktemp -d)"
trap 'rm -rf "$payload"' EXIT
dpkg-deb -x "$deb" "$payload"

[ -x "$payload/usr/bin/tuxbooks" ] || fail "usr/bin/tuxbooks missing or not executable"
[ -f "$payload/usr/lib/tuxbooks/pdfium/libpdfium.so" ] ||
  fail "bundled PDFium resource missing (usr/lib/tuxbooks/pdfium/libpdfium.so)"

desktop="$payload/usr/share/applications/tuxbooks.desktop"
[ -f "$desktop" ] || fail "desktop entry missing (usr/share/applications/tuxbooks.desktop)"
grep -q '^Exec=tuxbooks' "$desktop" || fail "desktop entry has no Exec=tuxbooks"
grep -q '^Icon=tuxbooks' "$desktop" || fail "desktop entry has no Icon=tuxbooks"
grep -q '^Type=Application' "$desktop" || fail "desktop entry is not Type=Application"
grep -q '^Terminal=false' "$desktop" || fail "desktop entry does not set Terminal=false"

icon_count="$(find "$payload/usr/share/icons/hicolor" -name 'tuxbooks.png' 2>/dev/null | wc -l)"
[ "$icon_count" -ge 3 ] ||
  fail "expected at least 3 hicolor icon sizes, found $icon_count"

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$desktop" || fail "desktop-file-validate rejected the desktop entry"
else
  echo "check-deb: desktop-file-validate not installed; skipped (structure still checked)"
fi

echo "check-deb: OK (version $version, $arch, $icon_count icons, PDFium bundled)"
