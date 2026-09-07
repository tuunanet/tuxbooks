set shell := ["bash", "-uc"]

root := justfile_directory()

default: check

# Regenerate the committed EPUB fixture corpus (tests/fixtures/epub/):
# deterministic source trees + artifacts + manifest. Byte-identical per run.
make-epub-fixtures:
    python3 scripts/make-epub-fixtures.py

# Fetch the PDFium shared library used for PDF cover extraction
# (src-tauri/pdfium/, gitignored). Idempotent: skips when already present.
# The pinned build tracks pdfium-render's default bindings (docs/build.md).
fetch-pdfium:
    bash scripts/fetch-pdfium.sh

# Validate the EPUB fixture corpus: determinism, manifest checksums, EPUB
# version identity, malformed markers, and the committed size budget.
check-epub-fixtures:
    python3 scripts/make-epub-fixtures.py --check

# Launch the app in development mode: Vite dev server (hot reload for the
# renderer), the Rust sidecar (debug build), and the Electron shell.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{root}}"
    # A stale dev server (crashed run, leftover terminal) holds the port and
    # Vite would die with a cryptic bind error — fail with the fix instead.
    if (exec 3<>/dev/tcp/127.0.0.1/1420) 2>/dev/null; then
        echo "dev: port 1420 is already in use — stop the other tuxbooks dev server first." >&2
        exit 1
    fi
    cargo build --manifest-path src-tauri/Cargo.toml
    node scripts/build-electron.mjs
    pnpm --filter frontend dev &
    vite_pid=$!
    trap 'kill $vite_pid 2>/dev/null || true' EXIT
    # Wait for the Vite server (port 1420, strictPort) before opening the shell.
    for _ in $(seq 1 120); do
        if (exec 3<>/dev/tcp/127.0.0.1/1420) 2>/dev/null; then
            exec 3>&- 3<&- || true
            break
        fi
        sleep 0.5
    done
    VITE_DEV_SERVER_URL=http://localhost:1420 pnpm exec electron .

# GNU timeout is the last-resort hang guard for test commands (linux only:
# macOS lacks coreutils' timeout). Healthy runs finish in a fraction of
# these bounds; a wedged run is killed instead of blocking development.
_test_timeout := if os() == "linux" { "timeout --kill-after=15 900" } else { "" }

# Build everything the packaged app needs: renderer bundle, Electron
# main/preload bundles, and the release sidecar binary.
build: fetch-pdfium
    pnpm --filter frontend build
    node scripts/build-electron.mjs
    cargo build --manifest-path src-tauri/Cargo.toml --release

# Unit tests: rust + frontend, concurrently (different toolchains — cargo
# and node never contend). fetch-pdfium first so PDF cover tests exercise a
# real render, not a skip.
test: test-parallel

test-rust: fetch-pdfium
    {{_test_timeout}} cargo test --manifest-path src-tauri/Cargo.toml

test-frontend:
    {{_test_timeout}} pnpm --filter frontend test:ci

test-parallel:
    bash scripts/run-parallel.sh \
        'rust: just test-rust' \
        'frontend: just test-frontend'

# Build the app the E2E suite runs against: renderer bundle, Electron
# main/preload bundles, and the debug sidecar. The Electron harness needs
# no special frontend build (the old VITE_WDIO flag died with Tauri).
build-debug:
    pnpm --filter frontend build
    node scripts/build-electron.mjs
    cargo build --manifest-path src-tauri/Cargo.toml

# E2E runs the real Electron app against WebdriverIO. Headless by default:
# on Linux each phase runs under a private Xvfb. Unsetting WAYLAND_DISPLAY
# alone is NOT enough on Wayland desktops — Chromium still finds the
# compositor socket in XDG_RUNTIME_DIR — so ELECTRON_OZONE_PLATFORM_HINT=x11
# pins the app to the virtual X display (same mechanism as the old
# GDK_BACKEND=x11 for WebKitGTK). timeout is the last-resort guard so an
# agent invocation always terminates; E2E_XVFB marks the watchdog to sweep
# the phase's private Xvfb if teardown is killed.
_e2e_timeout := if os() == "linux" { "timeout --kill-after=15 600" } else { "" }
_x11 := if os() == "linux" { "env -u WAYLAND_DISPLAY ELECTRON_OZONE_PLATFORM_HINT=x11" } else { "" }
_headless := if os() == "linux" { _x11 + " E2E_XVFB=1 xvfb-run --auto-servernum" } else { "" }

# Fetch the chromedriver matching the app's Electron version
# (.build/chromedriver/, gitignored). The service's own downloader hangs;
# the harness needs this binary (docs/testing.md, docs/build.md).
fetch-chromedriver:
    bash scripts/fetch-chromedriver.sh

test-e2e: build-debug fetch-chromedriver
    just test-e2e-empty
    just test-e2e-seeded

test-e2e-empty: fetch-chromedriver
    {{_headless}} {{_e2e_timeout}} env E2E_PHASE=empty E2E_SEED_LIBRARY= pnpm --filter e2e test:empty

test-e2e-seeded: fetch-chromedriver
    {{_headless}} {{_e2e_timeout}} env E2E_PHASE=seeded E2E_SEED_LIBRARY=1 pnpm --filter e2e test:seeded

# Same suites on the developer's real display, for visual debugging.
test-e2e-headed: build-debug fetch-chromedriver
    just test-e2e-headed-empty
    just test-e2e-headed-seeded

test-e2e-headed-empty: fetch-chromedriver
    {{_x11}} env E2E_PHASE=empty E2E_SEED_LIBRARY= pnpm --filter e2e test:empty

test-e2e-headed-seeded: fetch-chromedriver
    {{_x11}} env E2E_PHASE=seeded E2E_SEED_LIBRARY=1 pnpm --filter e2e test:seeded

# Reader performance benchmark (docs/performance.md "How to measure"):
# MEASURES pdf render→blit and epub scrolled-flow latency on the real-book
# Agents fixtures, starting mid-book, with the window MAXIMIZED on the real
# display (explicit WxH argument overrides). Asserts only the deterministic
# budgets (PERF-1/3/4) and writes artifacts/e2e/<runId>/bench-results.json.
# HEADED and opt-in — never Xvfb, never CI (timing assertions are excluded
# from CI by policy).
_bench_timeout := if os() == "linux" { "timeout --kill-after=15 900" } else { "" }

bench-reader WINDOW_SIZE="": build-debug fetch-chromedriver
    {{_bench_timeout}} env E2E_PHASE=bench E2E_SEED_LIBRARY= BENCH_WINDOW_SIZE="{{WINDOW_SIZE}}" pnpm --filter e2e test:bench

# Opt-in large fixture tiers (docs/testing.md). Never invoked by `just test`,
# `just check`, or normal CI: the default suite is fully self-contained.

# Fetch extended/conformance EPUB datasets declared in
# tests/fixtures/epub/fixtures.toml into .build/fixtures/epub/ (cached,
# checksum-verified). Downloads once, never per test run.
fetch-epub-extended:
    python3 scripts/fetch-epub-extended.py

# Tier B: run the real-world corpus through the parser. Requires a prior
# `just fetch-epub-extended`; skips with a notice when nothing is fetched.
test-epub-extended:
    {{_test_timeout}} cargo test --manifest-path src-tauri/Cargo.toml --test extended_epub extended::

# Tier C: run the external W3C conformance corpus. Same opt-in contract.
test-epub-conformance:
    {{_test_timeout}} cargo test --manifest-path src-tauri/Cargo.toml --test extended_epub conformance::

lint: lint-rust lint-frontend lint-electron lint-workflows

lint-rust:
    cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings

lint-frontend:
    pnpm --filter frontend lint

lint-electron:
    node scripts/build-electron.mjs >/dev/null
    pnpm exec tsc -p electron --noEmit

# Lint GitHub Actions workflows (expressions, references, run: shell).
# Downloads the pinned binary on first use (scripts/install-actionlint.sh),
# then runs offline from .build/bin/.
lint-workflows:
    bash scripts/install-actionlint.sh
    .build/bin/actionlint

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
    pnpm exec tsc -p electron --noEmit

# Full local validation. The streams are independent toolchains, so they run
# concurrently (wall time = the slowest stream, usually rust). Cargo work
# stays in one stream: parallel cargo commands would just block each other
# on the target-dir file lock.
check:
    bash scripts/run-parallel.sh \
        'rust: just format-check-rust && just lint-rust && just test-rust' \
        'frontend-test: just test-frontend' \
        'frontend-lint: just lint-frontend' \
        'frontend-types: just typecheck' \
        'format: just format-check-frontend' \
        'fixtures: just check-epub-fixtures' \
        'workflows: just lint-workflows'
    @echo "check: OK"

# Coverage gate (docs/coverage.md). Frontend thresholds are enforced by
# every vitest run; this recipe adds the Rust instrumented run (slow first
# time: cargo-llvm-cov keeps its own target dir).
coverage:
    node scripts/coverage-gate.mjs
    pnpm --filter frontend exec vitest run --coverage --coverage.reporter=text-summary
