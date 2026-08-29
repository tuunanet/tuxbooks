#!/usr/bin/env bash
# Emits environment values used by the justfile.
#
# On developer machines with system-installed WebKitGTK this is a no-op: the
# pre-existing environment is passed through unchanged. On machines without
# root (where webkit2gtk-4.1 was extracted to ~/.local from .deb packages),
# the user-local paths are appended so that cargo/tauri can compile and run.
set -euo pipefail

mode="${1:?usage: dev-env.sh pkgconfig|ldpath|path}"
local_lib="$HOME/.local/usr/lib/x86_64-linux-gnu"
local_bin="$HOME/.local/usr/bin"

append() {
  local current="${2:-}"
  if [ -n "$current" ]; then
    printf '%s:%s\n' "$current" "$1"
  else
    printf '%s\n' "$1"
  fi
}

case "$mode" in
  pkgconfig)
    if [ -d "$local_lib/pkgconfig" ]; then
      append "$local_lib/pkgconfig" "${PKG_CONFIG_PATH:-}"
    else
      printf '%s\n' "${PKG_CONFIG_PATH:-}"
    fi
    ;;
  ldpath)
    if [ -d "$local_lib" ]; then
      append "$local_lib" "${LD_LIBRARY_PATH:-}"
    else
      printf '%s\n' "${LD_LIBRARY_PATH:-}"
    fi
    ;;
  path)
    if [ -x "$local_bin/WebKitWebDriver" ]; then
      append "$local_bin" "${PATH:-}"
    else
      printf '%s\n' "${PATH:-}"
    fi
    ;;
  *)
    echo "unknown mode: $mode" >&2
    exit 1
    ;;
esac
