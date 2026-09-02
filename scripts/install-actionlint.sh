#!/usr/bin/env bash
# Install the pinned actionlint binary into .build/bin/ (gitignored).
#
# Idempotent: skips the download when the pinned version is already present,
# so `just check` stays offline-friendly after the first run. The tarball is
# verified against the checksums embedded below (upstream
# actionlint_<version>_checksums.txt, linux/darwin amd64+arm64).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="1.7.12"
dest_dir="$root/.build/bin"
dest="$dest_dir/actionlint"

if [ -x "$dest" ] && [ "$("$dest" --version | head -n 1)" = "$version" ]; then
  exit 0
fi

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux) platform="linux" ;;
  Darwin) platform="darwin" ;;
  *) echo "install-actionlint.sh: unsupported OS: $os" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64) platform="${platform}_amd64" ;;
  aarch64 | arm64) platform="${platform}_arm64" ;;
  *) echo "install-actionlint.sh: unsupported arch: $arch" >&2; exit 1 ;;
esac

case "$platform" in
  linux_amd64) expected="8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8" ;;
  linux_arm64) expected="325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6" ;;
  darwin_amd64) expected="5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644" ;;
  darwin_arm64) expected="aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f" ;;
  *) echo "install-actionlint.sh: no pinned checksum for $platform" >&2; exit 1 ;;
esac

url="https://github.com/rhysd/actionlint/releases/download/v${version}/actionlint_${version}_${platform}.tar.gz"
mkdir -p "$dest_dir"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --retry 3 -o "$tmp/actionlint.tar.gz" "$url"
echo "$expected  $tmp/actionlint.tar.gz" | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -)
tar -xzf "$tmp/actionlint.tar.gz" -C "$tmp" actionlint
mv "$tmp/actionlint" "$dest"

"$dest" --version
