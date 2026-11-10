#!/usr/bin/env bash
# Install the pinned just binary into .build/bin/ (gitignored).
#
# Replaces extractions/setup-just in CI. The action floats to the latest
# just release, and its ~24s of built-in retries were exhausted twice by
# GitHub-releases 504 brownouts (PRs #399 and #400 — jobs 129039781671 and
# 129039836863 both died at "Install just" on Nov 9 2026). This follows the
# house install pattern (see install-actionlint.sh): a pinned version
# verified against the upstream release checksums, plus curl retry wide
# enough to ride out the brownouts. Idempotent: skips the download when the
# pinned version is already present.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="1.59.0"
dest_dir="$root/.build/bin"
dest="$dest_dir/just"

if [ -x "$dest" ] && [ "$("$dest" --version 2>/dev/null)" = "just $version" ]; then
  exit 0
fi

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux) triple="unknown-linux-musl" ;;
  Darwin) triple="apple-darwin" ;;
  *) echo "install-just.sh: unsupported OS: $os" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64) triple="x86_64-$triple" ;;
  aarch64 | arm64) triple="aarch64-$triple" ;;
  *) echo "install-just.sh: unsupported arch: $arch" >&2; exit 1 ;;
esac

# sha256 digests recorded at pin time from the release's SHA256SUMS asset
# (tag 1.59.0), then cross-checked by downloading the tarball and hashing it.
case "$triple" in
  x86_64-unknown-linux-musl) expected="409044617b6f06517c1035e55ca38c8c856ff8b650e41bc2aa1ef82d5903a23e" ;;
  aarch64-unknown-linux-musl) expected="23871b1702bfd550fb5f901778fd4290ecf2ee034a45a889fbe96d89b188086d" ;;
  x86_64-apple-darwin) expected="036ead9df9bc31dbae9934ae3b4236ed124d0bafcffd33439460ae084d5c9cb7" ;;
  aarch64-apple-darwin) expected="6574cea774ed4cae12e24b6aa11857de33e80dab4667cf628fd5840df96a2a9d" ;;
  *) echo "install-just.sh: no pinned checksum for $triple" >&2; exit 1 ;;
esac

# (casey/just tags have no "v" prefix.)
url="https://github.com/casey/just/releases/download/${version}/just-${version}-${triple}.tar.gz"
mkdir -p "$dest_dir"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Same retry budget as fetch-pdfium.sh: the brownouts that killed the
# pdfium fetch also killed setup-just, so thirteen attempts over a bounded
# 360s window (delays + transfers) rides them out, and a permanently broken
# URL still fails within ~6 minutes.
curl -fsSL --connect-timeout 15 --retry 12 --retry-all-errors \
  --retry-delay 20 --retry-max-time 360 -o "$tmp/just.tar.gz" "$url"
echo "$expected  $tmp/just.tar.gz" | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -)
tar -xzf "$tmp/just.tar.gz" -C "$tmp" just
mv "$tmp/just" "$dest"

"$dest" --version
