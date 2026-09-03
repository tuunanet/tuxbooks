#!/usr/bin/env bash
# Fetch the PDFium shared library used for PDF cover extraction at import
# time (src-tauri/src/pdf/render.rs). Idempotent: exits early when
# src-tauri/pdfium/libpdfium.so already exists.
#
# The build tag below must match the Pdfium build that pdfium-render's
# default `pdfium_latest` feature generates bindings for (7881 for
# pdfium-render 0.9.x). Bump both together when upgrading pdfium-render.
# See docs/build.md.
set -euo pipefail

PDFIUM_BUILD="chromium/7881"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src-tauri/pdfium"

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ASSET="pdfium-linux-x64.tgz" ;;
  Linux-aarch64) ASSET="pdfium-linux-arm64.tgz" ;;
  *) echo "fetch-pdfium: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

if [ -f "$DEST/libpdfium.so" ]; then
  exit 0
fi

url="https://github.com/bblanchon/pdfium-binaries/releases/download/$PDFIUM_BUILD/$ASSET"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL "$url" -o "$tmp/pdfium.tgz"
tar -xzf "$tmp/pdfium.tgz" -C "$tmp"
mkdir -p "$DEST"
mv "$tmp/lib/libpdfium.so" "$DEST/libpdfium.so"
version="$(cat "$tmp/VERSION" 2>/dev/null || echo "$PDFIUM_BUILD")"
echo "fetch-pdfium: installed $version at src-tauri/pdfium/libpdfium.so"
