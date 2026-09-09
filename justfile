set shell := ["bash", "-uc"]

root := justfile_directory()

default: check

# Regenerate the committed EPUB fixture corpus (tests/fixtures/epub/):
# deterministic source trees + artifacts + manifest. Byte-identical per run.
make-epub-fixtures:
    python3 scripts/make-epub-fixtures.py

# Fetch the PDFium shared library used for PDF cover extraction
# (sidecar/pdfium/, gitignored). Idempotent: skips when already present.
# The pinned build tracks pdfium-render's default bindings (docs/build.md).
fetch-pdfium:
    bash scripts/fetch-pdfium.sh

# Validate the EPUB fixture corpus: determinism, manifest checksums, EPUB
# version identity, malformed markers, and the committed size budget.
check-epub-fixtures:
    python3 scripts/make-epub-fixtures.py --check

# Download the free ebook fixture corpus (tests/fixtures/books/EBooks/, ~11 MB).
# Idempotent: downloads only files missing from or failing the sha256 manifest
# (docs/free-ebook-fixtures.md). Not part of `just check`/`just test` — needs
# network; tests that use the corpus skip when it is absent.
fetch-ebooks:
    python3 scripts/fetch-ebook-fixtures.py

# Verify the free ebook corpus against its manifest (no network, no download).
check-ebooks:
    python3 scripts/fetch-ebook-fixtures.py --check

# Launch the app in development mode: Vite dev server (hot reload for the
# renderer), the Rust sidecar (debug build), and the Electron shell.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    cd "{{root}}"
    # Port probes must try BOTH stacks: Vite binds localhost through
    # getaddrinfo and on IPv6-first machines lands on [::1] only — probing
    # 127.0.0.1 alone then never connects, and the wait loop below spun the
    # full 120x0.5s = 60s before Electron even launched (the reported ~30s
    # "stuck" startup; docs/dev-startup-latency.md).
    port_open() {
        (exec 3<>/dev/tcp/127.0.0.1/1420) 2>/dev/null && { exec 3>&- 3<&-; return 0; }
        (exec 3<>/dev/tcp/::1/1420) 2>/dev/null && { exec 3>&- 3<&-; return 0; }
        return 1
    }
    # A stale dev server (crashed run, leftover terminal) holds the port and
    # Vite would die with a cryptic bind error — fail with the fix instead.
    if port_open; then
        echo "dev: port 1420 is already in use — stop the other tuxbooks dev server first." >&2
        exit 1
    fi
    cargo build --manifest-path sidecar/Cargo.toml
    node scripts/build-electron.mjs
    # setsid makes Vite a process-group leader: cleanup kills the whole group
    # (pnpm + node + vite), not just the direct PID — descendants survive a
    # plain `kill $pid` and hold port 1420, which is what forced the old
    # `fuser -k 1420/tcp` workaround (docs/dev-startup-latency.md §8).
    setsid pnpm --filter frontend dev &
    vite_pid=$!
    cleanup() {
        trap - EXIT INT TERM
        kill -TERM -- -"$vite_pid" 2>/dev/null || true
        # Bounded wait for the group to die, then escalate: the port must be
        # released by the time this recipe exits, on Electron exit, Ctrl+C,
        # or external termination alike.
        for _ in $(seq 1 20); do
            kill -0 -- -"$vite_pid" 2>/dev/null || return 0
            sleep 0.1
        done
        kill -KILL -- -"$vite_pid" 2>/dev/null || true
        wait "$vite_pid" 2>/dev/null || true
    }
    trap cleanup EXIT
    trap 'cleanup; exit 130' INT TERM
    # Wait for the Vite server (port 1420, strictPort) before opening the shell.
    for _ in $(seq 1 120); do
        if port_open; then
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
    cargo build --manifest-path sidecar/Cargo.toml --release

# Package the distributable Linux bundles with electron-builder
# (electron-builder.yml). Requires `just build` artifacts — the recipe runs
# it first. Default targets: deb + rpm + AppImage (docs/release.md); a
# target list argument narrows the run (e.g. `just package deb`). The rpm
# needs the `rpm` package (rpmbuild) installed. `--publish never`: this
# recipe only builds artifacts — electron-builder 26 otherwise publishes
# implicitly on CI push builds (which needs GH_TOKEN); release.yml cuts the
# release itself via `gh release create`.
package TARGETS="deb rpm AppImage": build
    pnpm exec electron-builder --linux {{TARGETS}} --publish never

# Packaging regression gate (docs/release.md): verifies the deb built by
# `just package` — control metadata, payload (Electron + sidecar + PDFium),
# desktop entry, and hicolor icons.
check-deb:
    bash scripts/check-deb.sh

# Unit tests: rust + frontend, concurrently (different toolchains — cargo
# and node never contend). fetch-pdfium first so PDF cover tests exercise a
# real render, not a skip.
test: test-parallel

test-rust: fetch-pdfium
    {{_test_timeout}} cargo test --manifest-path sidecar/Cargo.toml

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
    cargo build --manifest-path sidecar/Cargo.toml

# E2E runs the real Electron app against Playwright (Playwright's Electron
# launcher spawns the local electron binary pointed at the built main
# bundle). Headless by default: on Linux each phase runs under a private
# Xvfb. Unsetting WAYLAND_DISPLAY alone is NOT enough on Wayland desktops —
# Chromium still finds the compositor socket in XDG_RUNTIME_DIR — so
# ELECTRON_OZONE_PLATFORM_HINT=x11 pins the app to the virtual X display
# (the launch fixture additionally passes --ozone-platform=x11). timeout is
# the last-resort guard so an agent invocation always terminates; E2E_XVFB
# marks the watchdog to sweep the phase's private Xvfb if teardown is killed.
_e2e_timeout := if os() == "linux" { "timeout --kill-after=15 600" } else { "" }
_x11 := if os() == "linux" { "env -u WAYLAND_DISPLAY ELECTRON_OZONE_PLATFORM_HINT=x11" } else { "" }
_headless := if os() == "linux" { _x11 + " E2E_XVFB=1 xvfb-run --auto-servernum" } else { "" }

test-e2e: build-debug
    just test-e2e-empty
    just test-e2e-shell
    just test-e2e-seeded

test-e2e-empty:
    {{_headless}} {{_e2e_timeout}} env E2E_PHASE=empty E2E_SEED_LIBRARY= pnpm --filter e2e test:empty

# Desktop-shell suite (docs/fix-electron-main-window-behaviour.md §17):
# native window lifecycle, branding, and the repeated-launch policy. A
# 1920x1080 virtual screen gives the default 1280x820 window real centering
# headroom (xvfb-run's 1280x1024 default would hug the left/right edges).
# True maximize/restore needs a window manager — bare Xvfb has none, so
# those scenarios skip here and run under test-e2e-headed-shell.
_shell_headless := _x11 + " E2E_XVFB=1 xvfb-run --auto-servernum --server-args='-screen 0 1920x1080x24'"

test-e2e-shell: build-debug
    {{_shell_headless}} {{_e2e_timeout}} env E2E_PHASE=shell E2E_SEED_LIBRARY= pnpm --filter e2e test:shell

# Same suite on the real desktop (the developer's WM participates): the
# maximize/restore/resize scenarios run for real instead of skipping.
test-e2e-headed-shell: build-debug
    {{_x11}} {{_e2e_timeout}} env E2E_PHASE=shell E2E_SEED_LIBRARY= pnpm --filter e2e test:shell

test-e2e-seeded:
    {{_headless}} {{_e2e_timeout}} env E2E_PHASE=seeded E2E_SEED_LIBRARY=1 pnpm --filter e2e test:seeded

# High-DPI configuration (docs/performance.md reference conditions name dpr
# 2.0): the seeded reader scenarios against an app forced to
# devicePixelRatio 2 via E2E_DEVICE_SCALE_FACTOR → --force-device-scale-factor.
test-e2e-hidpi: build-debug
    {{_headless}} {{_e2e_timeout}} env E2E_PHASE=hidpi E2E_SEED_LIBRARY=1 E2E_DEVICE_SCALE_FACTOR=2 pnpm --filter e2e test:hidpi

# Production-form build: same renderer/Electron bundles, but the RELEASE
# sidecar binary through TUXBOOKS_SIDECAR (the packaged-app resource
# resolution path; see docs/release.md for packaging).
# just does not interpolate {{root}} inside variable assignments — build the
# path with string concatenation so the override is a real binary path.
_release_sidecar := justfile_directory() + "/sidecar/target/release/tuxbooks"

test-e2e-release: build-debug
    cargo build --manifest-path sidecar/Cargo.toml --release
    {{_headless}} {{_e2e_timeout}} env E2E_PHASE=empty E2E_SEED_LIBRARY= TUXBOOKS_SIDECAR={{_release_sidecar}} pnpm --filter e2e test:empty
    {{_headless}} {{_e2e_timeout}} env E2E_PHASE=seeded E2E_SEED_LIBRARY=1 TUXBOOKS_SIDECAR={{_release_sidecar}} pnpm --filter e2e test:seeded

# Same suites on the developer's real display, for visual debugging.
test-e2e-headed: build-debug
    just test-e2e-headed-empty
    just test-e2e-headed-seeded

test-e2e-headed-empty:
    {{_x11}} env E2E_PHASE=empty E2E_SEED_LIBRARY= pnpm --filter e2e test:empty

test-e2e-headed-seeded:
    {{_x11}} env E2E_PHASE=seeded E2E_SEED_LIBRARY=1 pnpm --filter e2e test:seeded

# Reader performance benchmark (docs/performance.md "How to measure"):
# MEASURES pdf render→blit and epub scrolled-flow latency on the real-book
# Agents fixtures, starting mid-book, with the window MAXIMIZED on the real
# display (explicit WxH argument overrides). Asserts only the deterministic
# budgets (PERF-1/3/4) and writes artifacts/e2e/<runId>/bench-results.json.
# HEADED and opt-in — never Xvfb, never CI (timing assertions are excluded
# from CI by policy).
_bench_timeout := if os() == "linux" { "timeout --kill-after=15 900" } else { "" }

bench-reader WINDOW_SIZE="": build-debug
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
    {{_test_timeout}} cargo test --manifest-path sidecar/Cargo.toml --test extended_epub extended::

# Tier C: run the external W3C conformance corpus. Same opt-in contract.
test-epub-conformance:
    {{_test_timeout}} cargo test --manifest-path sidecar/Cargo.toml --test extended_epub conformance::

lint: lint-rust lint-frontend lint-electron lint-workflows

lint-rust:
    cargo clippy --manifest-path sidecar/Cargo.toml --all-targets --all-features -- -D warnings

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
    cargo fmt --manifest-path sidecar/Cargo.toml
    pnpm format

format-check: format-check-rust format-check-frontend

format-check-rust:
    cargo fmt --manifest-path sidecar/Cargo.toml --check

format-check-frontend:
    pnpm format:check

typecheck:
    pnpm --filter frontend typecheck
    pnpm exec tsc -p electron --noEmit
    pnpm --filter e2e exec tsc -p . --noEmit

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
