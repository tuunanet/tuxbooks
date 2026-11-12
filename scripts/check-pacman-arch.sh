#!/usr/bin/env bash
# Resolve the Arch package's dependency transaction inside a current Arch
# container. check-pacman.sh validates metadata and payload on the build
# host; this catches a dependency that Arch has removed from its
# repositories before a release ships (the http-parser/libappindicator-gtk3
# failure mode).
#
# Needs docker or podman. The image tag floats on purpose: the check must see
# the current Arch repository state, not the state of a pinned image.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="$ROOT/dist-packages"
CONF="$ROOT/package.json"

fail() {
  echo "check-pacman-arch: FAIL: $*" >&2
  exit 1
}

if command -v docker >/dev/null 2>&1; then
  ENGINE=docker
elif command -v podman >/dev/null 2>&1; then
  ENGINE=podman
else
  fail "docker or podman is required to resolve dependencies against Arch"
fi

declared_version="$(jq -r .version "$CONF")"

shopt -s nullglob
packages=("$PACKAGE_DIR/tuxbooks-${declared_version}-1-x86_64.pkg.tar.zst")
shopt -u nullglob
if [ "${#packages[@]}" -ne 1 ]; then
  fail "expected one tuxbooks-${declared_version}-1-x86_64.pkg.tar.zst in $PACKAGE_DIR, found ${#packages[@]} (run \`just package pacman\` first)"
fi
pkg_name="$(basename "${packages[0]}")"

echo "check-pacman-arch: resolving $pkg_name against the Arch repositories"
"$ENGINE" run --rm \
  -e PKG_NAME="$pkg_name" \
  -v "$PACKAGE_DIR:/pkg:ro" \
  archlinux:latest \
  bash -euc '
    pacman -Sy --noconfirm >/dev/null
    transaction="$(pacman -U --print --print-format "%n" "/pkg/$PKG_NAME")"
    printf "%s\n" "$transaction" | grep -qx tuxbooks
  ' || fail "dependency resolution failed (a dependency is missing from Arch's repositories)"

echo "check-pacman-arch: OK ($pkg_name and its dependencies resolve)"
