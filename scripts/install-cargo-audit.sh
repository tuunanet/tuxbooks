#!/usr/bin/env bash
# Install the pinned cargo-audit binary into .build/bin/ (gitignored).
#
# cargo-audit has no pnpm footprint, so `just audit` and the CI audit
# workflow download the prebuilt release tarball directly (it is a static
# binary: no Rust toolchain needed to run it). Each tarball is verified
# against the sha256 digest embedded below, recorded at pin time from the
# upstream release artifacts (RustSec/rustsec, tag cargo-audit/v<version>).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="0.22.2"
dest_dir="$root/.build/bin"
dest="$dest_dir/cargo-audit"

if [ -x "$dest" ] && [ "$("$dest" --version 2>/dev/null)" = "cargo-audit $version" ]; then
  exit 0
fi

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux) platform="linux" ;;
  Darwin) platform="darwin" ;;
  *) echo "install-cargo-audit.sh: unsupported OS: $os" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64) platform="${platform}_amd64" ;;
  aarch64 | arm64) platform="${platform}_arm64" ;;
  *) echo "install-cargo-audit.sh: unsupported arch: $arch" >&2; exit 1 ;;
esac

# linux_amd64 ships a musl (static) build; the linux_arm64 and darwin
# builds are the gnu/apple triples upstream publishes.
case "$platform" in
  linux_amd64) triple="x86_64-unknown-linux-musl" expected="7fb9497f8594b389e5fce5ef9b92db08432996895b2e0c5a0167a69ed445c428" ;;
  linux_arm64) triple="aarch64-unknown-linux-gnu" expected="c6603814ddaa45e51263dafd31c0ac98808f688d26f7395804f9670b0fd599dd" ;;
  darwin_arm64) triple="aarch64-apple-darwin" expected="ec7ca4263769593df4d909be85b94a6b79efa2897be5d2bb8ebd516e823175af" ;;
  darwin_amd64) triple="x86_64-apple-darwin" expected="847831323de932155b226ab60ee4a180e13e5d007a019f0d4b7b4d89a6de2ab2" ;;
  *) echo "install-cargo-audit.sh: no pinned checksum for $platform" >&2; exit 1 ;;
esac

url="https://github.com/RustSec/rustsec/releases/download/cargo-audit/v${version}/cargo-audit-${triple}-v${version}.tgz"
mkdir -p "$dest_dir"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --retry 3 -o "$tmp/cargo-audit.tgz" "$url"
echo "$expected  $tmp/cargo-audit.tgz" | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -)
tar -xzf "$tmp/cargo-audit.tgz" -C "$tmp"
mv "$tmp"/cargo-audit-*/cargo-audit "$dest"

"$dest" --version
