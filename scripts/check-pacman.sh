#!/usr/bin/env bash
# Verify the Arch package produced by `just package` (electron-builder's
# pacman target). The package is installable-by-strangers, so its .PKGINFO
# must match the package.json version, keep the reviewed dependency list,
# and ship the desktop entry and hicolor icons; the bundled sidecar + worker
# must stay inside the glibc floor (docs/RELEASE.md "Pacman specifics",
# docs/BUILD.md "Release sidecar ABI floor").
#
# bsdtar reads the .pkg.tar.zst directly; Debian/Ubuntu ship it in
# libarchive-tools.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="$ROOT/dist-packages"
CONF="$ROOT/package.json"

fail() {
  echo "check-pacman: FAIL: $*" >&2
  exit 1
}

command -v bsdtar >/dev/null 2>&1 ||
  fail "bsdtar is required (Debian/Ubuntu: install libarchive-tools)"

declared_version="$(jq -r .version "$CONF")"

shopt -s nullglob
packages=("$PACKAGE_DIR/tuxbooks-${declared_version}-1-x86_64.pkg.tar.zst")
shopt -u nullglob
if [ "${#packages[@]}" -ne 1 ]; then
  fail "expected one tuxbooks-${declared_version}-1-x86_64.pkg.tar.zst in $PACKAGE_DIR, found ${#packages[@]} (run \`just package pacman\` first)"
fi
pkg="${packages[0]}"

echo "check-pacman: inspecting $(basename "$pkg")"

# --- .PKGINFO metadata -------------------------------------------------------
pkginfo="$(bsdtar -xOf "$pkg" .PKGINFO)" || fail "cannot read .PKGINFO"
[ -n "$pkginfo" ] || fail ".PKGINFO is empty"

field() {
  printf '%s\n' "$pkginfo" | sed -n "s/^$1 = //p" | head -n1
}

[ "$(field pkgname)" = "tuxbooks" ] ||
  fail "pkgname is '$(field pkgname)', expected tuxbooks"
[ "$(field pkgver)" = "${declared_version}-1" ] ||
  fail "pkgver $(field pkgver) does not match package.json ${declared_version}-1"
[ "$(field arch)" = "x86_64" ] || fail "arch is '$(field arch)', expected x86_64"
[ "$(field license)" = "GPL-3.0-or-later" ] ||
  fail "license is '$(field license)', expected GPL-3.0-or-later"
# electron-builder writes synopsis + indented description; libalpm keeps the
# first (non-empty) line, which is the synopsis.
[ -n "$(field pkgdesc)" ] || fail "empty package description"
[ -n "$(field packager)" ] || fail "empty packager"

depends="$(printf '%s\n' "$pkginfo" | sed -n 's/^depend = //p')"
# Mirrors electron-builder.yml's pacman.depends. It is a regression gate, not
# a second source of truth: changing the package's dependencies means updating
# both places, and this list keeping every entry is the point.
expected_depends="
alsa-lib
at-spi2-core
cairo
dbus
expat
glib2
glibc
gtk3
hicolor-icon-theme
libcups
libgcc
libx11
libxcb
libxcomposite
libxdamage
libxext
libxfixes
libxkbcommon
libxrandr
mesa
nspr
nss
pango
systemd-libs
xdg-utils
"
for dep in $expected_depends; do
  printf '%s\n' "$depends" | grep -qx "$dep" || fail "missing arch dependency $dep"
done
# These were electron-builder 26's pacman defaults but left Arch's repos, so
# a package that still names them cannot resolve.
for stale in http-parser libappindicator-gtk3; do
  if printf '%s\n' "$depends" | grep -qx "$stale"; then
    fail "depends on $stale, which Arch no longer provides"
  fi
done
case "$depends" in
*webkit*) fail "unexpected webkit runtime dependency (got: $depends)" ;;
esac

# --- payload ----------------------------------------------------------------
payload="$(mktemp -d)"
trap 'rm -rf "$payload"' EXIT
bsdtar -xf "$pkg" -C "$payload"

[ -x "$payload/opt/TuxBooks/tuxbooks" ] ||
  fail "opt/TuxBooks/tuxbooks missing or not executable"
[ -x "$payload/opt/TuxBooks/resources/sidecar/tuxbooks" ] ||
  fail "bundled sidecar missing or not executable (resources/sidecar/tuxbooks)"
[ -x "$payload/opt/TuxBooks/resources/sidecar/tuxbooks-worker" ] ||
  fail "bundled document worker missing or not executable (resources/sidecar/tuxbooks-worker)"
[ -f "$payload/opt/TuxBooks/resources/sidecar/libpdfium.so" ] ||
  fail "bundled PDFium resource missing (resources/sidecar/libpdfium.so)"
[ -f "$payload/opt/TuxBooks/resources/icons/512x512.png" ] ||
  fail "bundled window icon missing (resources/icons/512x512.png)"

# --- portability (glibc ABI floor) ------------------------------------------
# Shared with check-deb.sh; the floor and its rationale live in
# docs/BUILD.md "Release sidecar ABI floor".
bash "$ROOT/scripts/check-glibc-floor.sh" \
  "$payload/opt/TuxBooks/resources/sidecar" "check-pacman"

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
  echo "check-pacman: desktop-file-validate not installed; skipped (structure still checked)"
fi

echo "check-pacman: OK (version $declared_version-1, x86_64, $icon_count icons, sidecar + document worker + PDFium bundled, glibc floor OK)"
