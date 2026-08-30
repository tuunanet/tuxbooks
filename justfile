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

# Build the release application bundle.
build:
    pnpm tauri build

# Build an un-bundled debug binary with embedded assets (used by E2E).
build-debug:
    pnpm --filter frontend build
    cargo build --manifest-path src-tauri/Cargo.toml --features custom-protocol

test: test-rust test-frontend

test-rust: frontend-dist
    cargo test --manifest-path src-tauri/Cargo.toml

test-frontend:
    pnpm --filter frontend test:ci

# E2E needs a built binary; both phases run isolated scratch environments.
test-e2e: build-debug
    just test-e2e-empty
    just test-e2e-seeded

test-e2e-empty:
    E2E_SEED_LIBRARY= pnpm --filter e2e test:empty

test-e2e-seeded:
    E2E_SEED_LIBRARY=1 pnpm --filter e2e test:seeded

lint:
    cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
    pnpm --filter frontend lint

format:
    cargo fmt --manifest-path src-tauri/Cargo.toml
    pnpm format

format-check:
    cargo fmt --manifest-path src-tauri/Cargo.toml --check
    pnpm format:check

typecheck:
    pnpm --filter frontend typecheck

# Full local validation: format check -> lint -> typecheck -> unit tests.
check: format-check lint typecheck test
    @echo "check: OK"

# Complete CI-equivalent validation, including E2E and the release build.
ci: check test-e2e build
    @echo "ci: OK"
