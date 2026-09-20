# Pinned build environment for the release sidecar and document worker
# (scripts/build-sidecar-release.sh). It exists for one reason: the ABI
# floor. GitHub's ubuntu-24.04 runner links glibc 2.39, where Rust's weak
# pidfd_spawnp/pidfd_getpid references are bound to a real versioned symbol
# and recorded as a hard GLIBC_2.39 requirement, and the sidecar then refuses
# to load on Ubuntu 22.04 / Debian 12 ("version `GLIBC_2.39' not found").
# Linking against ubuntu:22.04 (glibc 2.35) keeps those weak references
# unversioned, so the binary's floor is 2.35. scripts/check-deb.sh asserts
# that ceiling on the packaged binaries.
#
# Digest-pinned: the tag can move, the digest cannot, so a release build
# cannot silently pick up a newer glibc. Bump deliberately (and re-check the
# glibc ceiling) when raising the floor.
FROM ubuntu:22.04@sha256:b8b6ee6aa931ecd9d0d952abc34dc0e5f7c6a30c6bb71b079fe399fde0329c02

ENV DEBIAN_FRONTEND=noninteractive
ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:$PATH

# build-essential: libsqlite3-sys compiles the bundled SQLite C sources.
# ca-certificates/curl: rustup bootstrap. Nothing else is needed:
# pdfium-render is bindings-only and probes libpdfium.so at runtime.
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://sh.rustup.rs \
 | sh -s -- -y --profile minimal --default-toolchain stable
