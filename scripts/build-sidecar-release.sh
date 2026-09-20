#!/usr/bin/env bash
# Build the release sidecar (tuxbooks) and the sandboxed worker
# (tuxbooks-worker) against a pinned glibc floor, inside a container.
#
# Why a container: on the ubuntu-24.04 CI runner (glibc 2.39), Rust's weak
# references to pidfd_spawnp/pidfd_getpid get bound to glibc's versioned
# symbols and recorded as a hard GLIBC_2.39 version need. The packaged app
# then dies the moment it starts the sidecar on any older distro with
# "version `GLIBC_2.39' not found". Building in the pinned ubuntu:22.04
# image (glibc 2.35) leaves those references unversioned, so the binaries
# load on Ubuntu 22.04 / Debian 12 as well. scripts/check-deb.sh fails the
# package if either binary exceeds the 2.35 ceiling.
#
# CARGO_HOME is the host's (~/.cargo) so crate downloads are shared with
# normal cargo builds and the CI cargo cache. Set
# TUXBOOKS_SIDECAR_HOST_BUILD=1 to skip the container and build on the host
# (fast, but not portable; the packaging gate rejects the result on a
# newer host).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKERFILE="$ROOT/scripts/sidecar-build.Dockerfile"
IMAGE="${TUXBOOKS_SIDECAR_IMAGE:-tuxbooks-sidecar-build:22.04}"

if [ "${TUXBOOKS_SIDECAR_HOST_BUILD:-0}" = "1" ]; then
  echo "build-sidecar-release: TUXBOOKS_SIDECAR_HOST_BUILD=1, host build (not portable)" >&2
  cargo build --manifest-path "$ROOT/sidecar/Cargo.toml" --release
  exit 0
fi

if command -v docker >/dev/null 2>&1; then
  ENGINE=docker
elif command -v podman >/dev/null 2>&1; then
  ENGINE=podman
else
  cat >&2 <<'EOF'
build-sidecar-release: no docker or podman found.
The release sidecar is built against glibc 2.35 in a container so the
packaged app runs on Ubuntu 22.04 / Debian 12 (docs/BUILD.md). Install
docker or podman, or set TUXBOOKS_SIDECAR_HOST_BUILD=1 for a host build
(not portable; `just check-deb` will reject it on a newer glibc).
EOF
  exit 1
fi

# Retry a command a few times with a short backoff. The image build and the
# in-container cargo build are the only steps that touch the network, and a
# registry or crates.io blip must not fail a release: the v0.0.10 publish
# failed once with "dial tcp [2600:1f18:...]:443: connect: network is
# unreachable" pulling the pinned image. BuildKit and cargo reuse their
# caches between attempts, so a retry is cheap.
retry() {
  local attempts="$1" delay="$2" attempt=1
  shift 2
  until "$@"; do
    if [ "$attempt" -ge "$attempts" ]; then
      echo "build-sidecar-release: failed after $attempt attempts: $*" >&2
      return 1
    fi
    echo "build-sidecar-release: attempt $attempt failed, retrying in ${delay}s: $*" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

CARGO_HOME_HOST="${CARGO_HOME:-$HOME/.cargo}"
mkdir -p "$CARGO_HOME_HOST"

retry 3 5 "$ENGINE" build -f "$DOCKERFILE" -t "$IMAGE" "$ROOT/scripts"

# --user keeps every file cargo writes in the bind-mounted workspace and
# CARGO_HOME owned by the invoking user, so no root-owned target/ afterward.
retry 3 5 "$ENGINE" run --rm \
  --user "$(id -u):$(id -g)" \
  -e CARGO_HOME=/cargo \
  -v "$CARGO_HOME_HOST":/cargo \
  -v "$ROOT":/work \
  -w /work/sidecar \
  "$IMAGE" \
  cargo build --release

echo "build-sidecar-release: built against the pinned glibc floor (ubuntu:22.04)"
