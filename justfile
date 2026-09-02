set shell := ["bash", "-uc"]

root := justfile_directory()

# scripts/dev-env.sh passes the environment through unchanged on machines with
# system WebKitGTK, and appends user-local webkit paths on no-sudo machines.
export PKG_CONFIG_PATH := `bash scripts/dev-env.sh pkgconfig`
export LD_LIBRARY_PATH := `bash scripts/dev-env.sh ldpath`
export PATH := `bash scripts/dev-env.sh path`

default: check

frontend-dist:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{root}}"
    test -f frontend/dist/index.html || pnpm --filter frontend build

# Launch the app in development mode (Vite dev server + Tauri window, hot reload).
dev:
    pnpm tauri dev

# GNU timeout is the last-resort hang guard for test commands (linux only:
# macOS lacks coreutils' timeout). Healthy runs finish in a fraction of
# these bounds; a wedged run is killed instead of blocking development.
_test_timeout := if os() == "linux" { "timeout --kill-after=15 900" } else { "" }
_e2e_timeout := if os() == "linux" { "timeout --kill-after=15 300" } else { "" }

# Build the release application bundle.
build:
    pnpm tauri build

# Build an un-bundled debug binary with embedded assets (used by E2E).
# VITE_WDIO=1 bundles the @wdio/tauri-plugin frontend bridge; every other
# build tree-shakes it out.
build-debug:
    VITE_WDIO=1 pnpm --filter frontend build
    cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol

# Unit tests: rust + frontend, concurrently (different toolchains — cargo
# and node never contend). `test-rust` pins custom-protocol so
# target/debug/tuxbooks always keeps the feature set build-debug gives it
# and `just check` no longer invalidates the E2E binary (docs/build.md).
test: test-parallel

test-rust: frontend-dist
    {{_test_timeout}} cargo test --manifest-path src-tauri/Cargo.toml --features custom-protocol

test-frontend:
    {{_test_timeout}} pnpm --filter frontend test:ci

test-parallel:
    bash scripts/run-parallel.sh \
        'rust: just test-rust' \
        'frontend: just test-frontend'

# E2E runs the real desktop app against WebdriverIO. Headless by default:
# on Linux each phase runs under a private Xvfb. `env -u WAYLAND_DISPLAY` is
# essential: xvfb-run only overrides DISPLAY, and a GTK3 app launched from a
# Wayland session otherwise prefers the (inherited) WAYLAND_DISPLAY and pops
# up on the real desktop instead of the virtual framebuffer. GDK_BACKEND=x11
# pins the choice. timeout is the last-resort guard so an agent invocation
# always terminates (healthy phases finish in under a minute; E2E_XVFB marks
# the watchdog to sweep the phase's private Xvfb if teardown is killed).
_headless := if os() == "linux" { "env -u WAYLAND_DISPLAY GDK_BACKEND=x11 E2E_XVFB=1 xvfb-run --auto-servernum" } else { "" }

test-e2e: build-debug
    just test-e2e-empty
    just test-e2e-seeded

test-e2e-empty:
    {{_headless}} {{_e2e_timeout}} env E2E_PHASE=empty E2E_SEED_LIBRARY= pnpm --filter e2e test:empty

test-e2e-seeded:
    {{_headless}} {{_e2e_timeout}} env E2E_PHASE=seeded E2E_SEED_LIBRARY=1 pnpm --filter e2e test:seeded

# Same suites on the developer's real display, for visual debugging.
test-e2e-headed: build-debug
    just test-e2e-headed-empty
    just test-e2e-headed-seeded

test-e2e-headed-empty:
    env E2E_PHASE=empty E2E_SEED_LIBRARY= pnpm --filter e2e test:empty

test-e2e-headed-seeded:
    env E2E_PHASE=seeded E2E_SEED_LIBRARY=1 pnpm --filter e2e test:seeded

lint: lint-rust lint-frontend

lint-rust:
    cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings

lint-frontend:
    pnpm --filter frontend lint

format:
    cargo fmt --manifest-path src-tauri/Cargo.toml
    pnpm format

format-check: format-check-rust format-check-frontend

format-check-rust:
    cargo fmt --manifest-path src-tauri/Cargo.toml --check

format-check-frontend:
    pnpm format:check

typecheck:
    pnpm --filter frontend typecheck

# Full local validation. The five streams are independent toolchains, so
# they run concurrently (wall time = the slowest stream, usually rust).
# Cargo work stays in one stream: parallel cargo commands would just block
# each other on the target-dir file lock.
check:
    bash scripts/run-parallel.sh \
        'rust: just format-check-rust && just lint-rust && just test-rust' \
        'frontend-test: just test-frontend' \
        'frontend-lint: just lint-frontend' \
        'frontend-types: just typecheck' \
        'format: just format-check-frontend'
    @echo "check: OK"

# Complete CI-equivalent validation, including E2E and the release build.
ci: check test-e2e build
    @echo "ci: OK"
