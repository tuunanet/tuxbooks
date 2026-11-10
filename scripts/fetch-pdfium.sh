#!/usr/bin/env bash
# Fetch the PDFium shared library used for PDF cover extraction at import
# time (sidecar/src/pdf/render.rs). Idempotent: exits early when
# sidecar/pdfium/libpdfium.so already exists.
#
# The build tag below must match the Pdfium build that pdfium-render's
# default `pdfium_latest` feature generates bindings for (7881 for
# pdfium-render 0.9.x). Bump both together when upgrading pdfium-render.
# See docs/BUILD.md.
set -euo pipefail

PDFIUM_BUILD="chromium/7881"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/sidecar/pdfium"

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

# GitHub releases intermittently 504s in minutes-long brownouts, not just
# seconds-long blips: on Nov 9 2026 the E2E run failed at 06:20Z and a fetch
# three hours later burned six 504s at 15s intervals (07:44:06-07:45:22, job
# 129039836966, PR #400) and was still being 504'd when its ~76s budget ran
# out. So the window is minutes, not seconds: thirteen attempts (1 + 12
# retries) at fixed 20s spacing, with --retry-max-time bounding delays and
# transfers together at 360s. A several-minute brownout rides out; the
# tradeoff is that a permanently broken URL now costs up to ~5-6 minutes
# before failing loudly — bounded, still no infinite hang.
# --retry-all-errors is required because -f turns the 504 into exit 22
# before curl's default transient-error retry check sees it.
curl -fsSL --connect-timeout 15 --retry 12 --retry-all-errors \
  --retry-delay 20 --retry-max-time 360 "$url" -o "$tmp/pdfium.tgz"
tar -xzf "$tmp/pdfium.tgz" -C "$tmp"
mkdir -p "$DEST"
mv "$tmp/lib/libpdfium.so" "$DEST/libpdfium.so"
version="$(cat "$tmp/VERSION" 2>/dev/null || echo "$PDFIUM_BUILD")"
echo "fetch-pdfium: installed $version at sidecar/pdfium/libpdfium.so"
