#!/usr/bin/env bash
# Verify the AppImage produced by `just package` (electron-builder).
#
# The AppImage's entry point is the runtime binary prepended to the squashfs,
# not our code, so this gate pins it to AppImage's static type2-runtime and
# then checks the payload it exposes (rationale: docs/RELEASE.md "AppImage
# specifics").
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_DIR="$ROOT/dist-packages"
CONF="$ROOT/package.json"

shopt -s nullglob
declared_version="$(jq -r .version "$CONF")"
images=("$IMAGE_DIR"/tuxbooks-"$declared_version".AppImage)
shopt -u nullglob
if [ "${#images[@]}" -ne 1 ]; then
  echo "check-appimage: expected exactly one tuxbooks-${declared_version}.AppImage in $IMAGE_DIR, found ${#images[@]}" >&2
  echo "check-appimage: run \`just package\` first" >&2
  exit 1
fi
image="${images[0]}"

fail() {
  echo "check-appimage: FAIL: $*" >&2
  exit 1
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "check-appimage: inspecting $(basename "$image")"

# --- runtime (the part that has to work before our code runs) ---------------
# The version line goes to stderr; the legacy runtime prints "Version: <hash>"
# there, which is exactly what the case below rejects.
runtime_version="$("$image" --appimage-version 2>&1)" ||
  fail "--appimage-version failed (runtime cannot start)"
case "$runtime_version" in
*type2-runtime*) ;;
*)
  fail "runtime is not AppImage's static type2-runtime (got: $runtime_version); check toolsets.appimage in electron-builder.yml"
  ;;
esac

# The static runtime links FUSE in; the legacy one dlopen()s libfuse.so.2 at
# exec time. The runtime header is ~1 MB and the squashfs follows it, so scan
# a 2 MB window: enough headroom for a runtime bump, no walk over the payload.
head -c 2000000 "$image" >"$work/runtime-header"
if grep -aq 'libfuse\.so\.2' "$work/runtime-header"; then
  fail "runtime references libfuse.so.2; users on Ubuntu 22.04+ cannot start it"
fi

file "$image" | grep -q 'static-pie linked' ||
  fail "runtime is not statically linked: $(file -b "$image")"

# --- payload ----------------------------------------------------------------
# `--appimage-extract` runs without mounting, so the gate works in containers
# and on hosts without FUSE.
mkdir "$work/payload"
(cd "$work/payload" && "$image" --appimage-extract >/dev/null) ||
  fail "--appimage-extract failed"
appdir="$work/payload/squashfs-root"

[ -x "$appdir/AppRun" ] || fail "AppRun missing or not executable"
[ -x "$appdir/tuxbooks" ] || fail "tuxbooks binary missing or not executable"
[ -x "$appdir/resources/sidecar/tuxbooks" ] ||
  fail "bundled sidecar missing or not executable (resources/sidecar/tuxbooks)"
[ -x "$appdir/resources/sidecar/tuxbooks-worker" ] ||
  fail "bundled document worker missing or not executable (resources/sidecar/tuxbooks-worker)"
[ -f "$appdir/resources/sidecar/libpdfium.so" ] ||
  fail "bundled PDFium resource missing (resources/sidecar/libpdfium.so)"
[ -f "$appdir/resources/icons/512x512.png" ] ||
  fail "bundled window icon missing (resources/icons/512x512.png)"

desktop="$appdir/tuxbooks.desktop"
[ -f "$desktop" ] || fail "desktop entry missing (tuxbooks.desktop)"
grep -q '^Exec=AppRun ' "$desktop" || fail "desktop entry does not launch through AppRun"
grep -q '^Name=TuxBooks' "$desktop" || fail "desktop entry Name is not TuxBooks"
grep -q '^Icon=tuxbooks' "$desktop" || fail "desktop entry has no Icon=tuxbooks"
grep -q '^Type=Application' "$desktop" || fail "desktop entry is not Type=Application"
grep -q '^Terminal=false' "$desktop" || fail "desktop entry does not set Terminal=false"
grep -q "^X-AppImage-Version=$declared_version\$" "$desktop" ||
  fail "desktop entry version does not match package.json $declared_version"
if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$desktop" || fail "desktop-file-validate rejected the desktop entry"
fi

# --- self-mount (best effort) ----------------------------------------------
# Mounting needs /dev/fuse and a setuid fusermount helper; the runtime skips a
# helper without the bit, so one cannot mount here. Skip when the host cannot
# mount at all (containers, CI runners), fail when it can and the image
# cannot.
mount_helper=""
if [ -e /dev/fuse ]; then
  for candidate in fusermount3 fusermount; do
    helper_path="$(command -v "$candidate" || true)"
    if [ -n "$helper_path" ] && [ -u "$helper_path" ]; then
      mount_helper="$helper_path"
      break
    fi
  done
fi
if [ -z "$mount_helper" ]; then
  echo "check-appimage: skipped self-mount probe (no /dev/fuse or setuid fusermount helper)"
else
  # APPIMAGE_EXTRACT_AND_RUN makes the runtime bypass mounting and reject
  # --appimage-mount, so clear it for the probe.
  set +e
  mount_out="$(env -u APPIMAGE_EXTRACT_AND_RUN timeout 10 "$image" --appimage-mount 2>&1)"
  mount_rc=$?
  set -e
  # Success prints the mount point and waits for EOF; exit 124 means the
  # image stayed mounted until the timeout.
  if [ "$mount_rc" -ne 124 ] || ! printf '%s\n' "$mount_out" | grep -q '^/'; then
    fail "self-mount failed (exit $mount_rc): $mount_out"
  fi
  echo "check-appimage: self-mount OK ($mount_out)"
fi

echo "check-appimage: OK (version $declared_version, static type2-runtime, payload complete)"
