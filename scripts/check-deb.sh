#!/usr/bin/env bash
# Verify the Debian bundle produced by `just package` (electron-builder).
# This is the packaging regression gate: the deb must be installable-by-
# strangers, so its control metadata must match the package.json version,
# the desktop entry must be valid, the hicolor icons must be installed, and
# the bundled sidecar + PDFium resource must be present (docs/RELEASE.md).
# Unlike the Tauri-era payload, the Electron deb must NOT depend on
# libwebkit2gtk.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEB_DIR="$ROOT/dist-packages"
CONF="$ROOT/package.json"

shopt -s nullglob
declared_version="$(jq -r .version "$CONF")"
debs=("$DEB_DIR"/tuxbooks_"$declared_version"_*.deb)
shopt -u nullglob
if [ "${#debs[@]}" -ne 1 ]; then
  echo "check-deb: expected exactly one tuxbooks_${declared_version}_*.deb in $DEB_DIR, found ${#debs[@]}" >&2
  echo "check-deb: run \`just package\` first" >&2
  exit 1
fi
deb="${debs[0]}"

fail() {
  echo "check-deb: FAIL: $*" >&2
  exit 1
}

echo "check-deb: inspecting $(basename "$deb")"

# --- control metadata -------------------------------------------------------
package="$(dpkg-deb -f "$deb" Package)"
version="$(dpkg-deb -f "$deb" Version)"
arch="$(dpkg-deb -f "$deb" Architecture)"
depends="$(dpkg-deb -f "$deb" Depends)"
description="$(dpkg-deb -f "$deb" Description)"

[ "$package" = "tuxbooks" ] || fail "package name is $package, expected tuxbooks"
[ "$version" = "$declared_version" ] ||
  fail "deb version $version does not match package.json $declared_version"
case "$arch" in
amd64 | arm64) ;;
*) fail "unexpected architecture $arch" ;;
esac
case "$depends" in
*webkit*) fail "unexpected webkit runtime dependency (got: $depends)" ;;
esac
[ -n "$description" ] || fail "empty package description"

# --- payload ----------------------------------------------------------------
# The install dir follows electron-builder productName (TuxBooks, human-
# facing); the executable, desktop filename, icon name, and WM class stay
# the stable technical identifier tuxbooks (executableName in
# electron-builder.yml — docs/fix-electron-main-window-behaviour.md §4/§15).
payload="$(mktemp -d)"
trap 'rm -rf "$payload"' EXIT
dpkg-deb -x "$deb" "$payload"

[ -x "$payload/opt/TuxBooks/tuxbooks" ] || fail "opt/TuxBooks/tuxbooks missing or not executable"
[ -x "$payload/opt/TuxBooks/resources/sidecar/tuxbooks" ] ||
  fail "bundled sidecar missing or not executable (resources/sidecar/tuxbooks)"
[ -f "$payload/opt/TuxBooks/resources/sidecar/libpdfium.so" ] ||
  fail "bundled PDFium resource missing (resources/sidecar/libpdfium.so)"
# The native window/taskbar icon at runtime (electron/main/index.ts
# appIconPath resolves resources/icons in packaged builds).
[ -f "$payload/opt/TuxBooks/resources/icons/512x512.png" ] ||
  fail "bundled window icon missing (resources/icons/512x512.png)"

desktop="$payload/usr/share/applications/tuxbooks.desktop"
[ -f "$desktop" ] || fail "desktop entry missing (usr/share/applications/tuxbooks.desktop)"
grep -q '^Exec=' "$desktop" || fail "desktop entry has no Exec line"
grep -q '^Name=TuxBooks' "$desktop" ||
  fail "desktop entry Name is not TuxBooks (launcher identity)"
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

echo "check-deb: OK (version $version, $arch, $icon_count icons, sidecar + PDFium bundled)"
