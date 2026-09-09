# Handover: Fix `just dev` Startup Latency and Process Lifecycle

**Repository:** `tuunanet/tuxbooks`
**Target branch:** `web-reader-prototype-1-e2e_playwright`
**Date:** 2026-09-09
**Priority:** High — local development startup is currently ~30 seconds and requires manual process cleanup.

## 1. Problem statement

Running:

```bash
just dev
```

currently behaves incorrectly on the developer machine.

Observed run:

```text
Finished `dev` profile ...
electron/dist/main.cjs ...
electron/dist/preload.cjs ...

> @tuxbooks/frontend@0.0.1 dev ...
> vite

VITE v7.3.6  ready in 164 ms
➜  Local:   http://localhost:1420/
```

At that point the terminal appears stuck for roughly **30 seconds before the tuxbooks window appears**.

Additionally, after the application eventually exits, the Vite process can remain alive and the next invocation fails:

```text
Error when starting dev server:
Error: Port 1420 is already in use
```

The developer currently has to manually run:

```bash
fuser -k 1420/tcp
```

before attempting `just dev` again.

This is not acceptable development UX.

## 2. Important diagnosis

Do **not** assume Vite is the 30-second bottleneck.

The observed Vite startup itself is:

```text
VITE v7.3.6 ready in 164 ms
```

The `justfile` then waits for port 1420 and launches Electron:

```text
pnpm --filter frontend dev &
...
VITE_DEV_SERVER_URL=http://localhost:1420 pnpm exec electron .
```

Therefore the missing ~30 seconds are after Vite becomes ready.

The investigation must explicitly measure:

```text
just dev
  ├─ cargo build
  ├─ Electron process startup
  ├─ app.whenReady()
  ├─ sidecar startup
  ├─ sidecar health check
  ├─ BrowserWindow creation
  ├─ renderer loadURL()
  ├─ Vite module transformation
  └─ renderer React mount
```

The current Electron main process starts the sidecar from `createWindow()`:

```ts
void sidecar.start().catch(...)
```

and the BrowserWindow is created with:

```ts
show: false;
```

and only shown from:

```ts
window.once("ready-to-show", () => {
  ...
  window.show();
});
```

Therefore a long delay can be hidden completely from the terminal.

## 3. Critical branch-state discrepancy

The existing branch currently performs startup reconciliation synchronously inside Rust `init_state()`.

Specifically, `init_state()` currently:

1. initializes the database pool;
2. optionally imports the E2E test library;
3. creates the reconciler;
4. starts the watcher;
5. lists library locations;
6. awaits `reconcile_location()` for every location;
7. optionally reconciles the test library;
8. runs the artwork-cache sweep;
9. only then returns `AppState`.

This is precisely the kind of work that can delay the sidecar health response.

The handover that described commit `3f294c1` as having moved reconciliation and cover sweeping behind the health check is therefore **not represented in the current branch state fetched from GitHub**.

Do not simply trust the old handover text. Inspect the actual branch implementation and fix the current code.

## 4. Required outcome

After the fix:

```bash
just dev
```

must behave like this:

```text
cargo build
Electron starts
Vite is ready
sidecar becomes healthy quickly
BrowserWindow opens
renderer mounts
```

A normal unchanged developer library should not block application window creation.

Target:

```text
Electron init              < 500 ms
sidecar healthy             < 500 ms
window visible              as soon as renderer is usable
renderer mounted            ~1–2 s in dev is acceptable
```

A library containing many changed books must **not** delay the initial window merely because startup reconciliation is expensive.

## 5. Fix the Rust startup ordering

Refactor `src-tauri/src/lib.rs`.

`init_state()` must perform only operations required to make the service safely usable immediately:

1. resolve database path;
2. initialize database pool;
3. create the reconciler;
4. start the watcher;
5. register existing watched locations;
6. register the test library when required;
7. return `AppState`.

Do **not** synchronously run the complete reconciliation walk before returning.

Instead:

```rust
let reconciler = ...;
let watcher = ...;

// Register locations synchronously.
let locations = list_locations(&pool).await?;

for location in locations {
    watcher.watch(Path::new(&location));
}

Ok(AppState {
    ...
})
```

Then spawn startup catch-up work:

```rust
tokio::spawn(async move {
    // reconcile locations
    // then sweep unreferenced covers
});
```

The exact implementation should preserve ownership/lifetimes and existing error handling.

### Ordering requirement

Background startup work must execute:

```text
reconciliation walk
        ↓
artwork-cache sweep
```

not concurrently.

Reason:

An import may create/update a cover image while reconciliation is still running. Running the garbage-collection sweep concurrently could incorrectly remove an image that is about to become referenced.

Therefore:

```rust
reconcile all locations
        ↓
sweep unreferenced covers
```

## 6. Preserve live UI updates

The existing reconciler already has an event callback which forwards service-layer changes as:

```text
library-changed
```

Keep this architecture.

When the background reconciliation imports or updates books:

```text
Rust reconciler
    ↓
library-changed
    ↓
JSON-RPC / Electron bridge
    ↓
renderer
```

The renderer must receive changes after the UI is already visible.

Do **not** reintroduce a startup barrier merely so the library appears completely populated before the first window is shown.

The application should open quickly and hydrate the library incrementally.

## 7. Preserve E2E seeded-library semantics

There is an important exception:

```text
TEST_LIBRARY_PATH
```

is used by the E2E seeded environment.

The seeded E2E path currently intentionally imports the fixture library during startup because tests expect books to exist when the first `list_books` call occurs.

Do not accidentally break this contract.

Prefer one of these designs:

### Preferred

Keep explicit E2E seeding synchronous when:

```text
TEST_LIBRARY_PATH
```

is set.

But keep normal developer startup asynchronous.

Conceptually:

```rust
if test_library {
    import_seed_library().await?;
}
```

while ordinary persisted-library reconciliation remains background work.

### Alternative

Change the E2E harness so it explicitly waits for reconciliation completion before the first library assertion.

Only use this alternative if it produces a cleaner architecture without weakening normal startup.

Do not sacrifice test determinism merely to optimize the E2E path.

## 8. Fix `just dev` process lifecycle

The current `justfile` starts Vite in the background:

```bash
pnpm --filter frontend dev &
vite_pid=$!
trap 'kill $vite_pid 2>/dev/null || true' EXIT
```

This is fragile.

The shell must guarantee that the Vite process and its descendants are terminated when Electron exits or when the recipe is interrupted.

Investigate process-group handling rather than merely killing the direct PID.

Example direction:

```bash
setsid pnpm --filter frontend dev &
vite_pid=$!
```

then terminate the process group during cleanup.

Do not blindly copy this example without verifying behavior with:

```bash
ps
pgrep
pstree
```

on Linux.

The final implementation must guarantee:

```text
just dev starts one Vite instance
Electron exits
Vite exits
port 1420 is released
next just dev works immediately
```

## 9. Do not rely on `fuser -k`

The developer workaround:

```bash
fuser -k 1420/tcp
```

must no longer be part of the normal workflow.

The recipe should clean up after itself.

The existing preflight check for port 1420 may remain, but improve its message only if useful. The important requirement is that a normal `just dev` shutdown leaves no stale Vite process.

## 10. Instrument the complete startup path

Add explicit timestamps to the startup path.

At minimum record:

```text
[startup] electron process +<ms>
[startup] app ready +<ms>
[startup] sidecar start +<ms>
[startup] sidecar healthy +<ms>
[startup] browser window created +<ms>
[startup] renderer load started +<ms>
[startup] renderer did-finish-load +<ms>
[startup] renderer mounted +<ms>
[startup] window shown +<ms>
```

Use a single monotonic origin where practical.

Do not use wall-clock differences for elapsed timing.

The purpose is to make the remaining 30-second gap impossible to hide.

## 11. Specifically investigate Electron `ready-to-show`

The current window is configured:

```ts
show: false;
```

and:

```ts
window.once("ready-to-show", () => {
    ...
    window.show();
});
```

`ready-to-show` can hide where the startup latency actually occurs.

Instrument both:

```text
did-start-loading
dom-ready
did-finish-load
ready-to-show
```

and compare them.

The agent must determine whether:

```text
loadURL → did-finish-load
```

or:

```text
did-finish-load → ready-to-show
```

contains the unexpected delay.

Do not change `show` behavior merely to make the application appear sooner until the cause is understood.

## 12. Investigate the Electron / Wayland path

The developer uses Linux/Wayland and a high-resolution display.

The previous investigation suspected that Electron initialization could potentially include:

- GPU initialization;
- compositor interaction;
- fontconfig initialization;
- high-DPI setup.

However, **do not add GPU-disabling or X11 workarounds without measurements**.

The project already has a policy that performance workarounds affecting GPU behavior require an identified cause.

Therefore:

```text
PERF-11:
no GPU workaround unless the measured startup data demonstrates that GPU/compositor
initialization is actually responsible.
```

First capture:

```text
[startup] app ready +...
```

on the real developer machine.

If this value is approximately 30 seconds, investigate Electron/Chromium initialization.

If this value is small, leave Electron platform initialization alone and continue down the startup path.

## 13. Investigate the sidecar independently

Run:

```bash
cargo build --manifest-path src-tauri/Cargo.toml
TEST_DATABASE_PATH=/tmp/tuxbooks-startup-test.db \
timeout 10 \
src-tauri/target/debug/tuxbooks </dev/null
```

Measure when:

```text
service ready
```

appears.

Then repeat with:

1. empty database;
2. unchanged real library;
3. library containing newly changed books;
4. many changed books.

Expected normal behavior after the fix:

```text
empty database            → fast
unchanged library         → fast
changed library           → fast service-ready + background reconciliation
```

A large changed library may still take seconds in the background. That is acceptable as long as service readiness is not blocked.

## 14. Add a background catch-up summary

When startup reconciliation completes, print one summary line.

Example:

```text
[startup] catch-up complete imported=3 updated=7 failed=0 duration=4821ms
```

This is preferable to many noisy per-file startup logs.

Include:

```text
imported
updated
removed
failed
duration
```

where the underlying reconciler can provide the information reliably.

Do not invent counts that cannot be derived accurately.

## 15. Investigate the remaining renderer latency

After fixing the backend/process issue, measure:

```text
renderer load started
renderer did-finish-load
renderer mounted
```

The expected current dev cost is approximately 1–2 seconds because Vite transforms a large dependency graph on first load.

Do not prematurely optimize this.

Only investigate:

- Vite dependency warmup;
- entry-chunk reduction;
- import graph reduction;
- code splitting

after the sidecar/process issue is fixed and the measurements show renderer boot is materially responsible.

Reader engines should remain lazy-loaded.

## 16. Keep Vite dependency optimization separate

A first run after dependency changes can trigger Vite dependency re-optimization.

This may be very slow once after dependency churn, while subsequent starts are fast.

That is not the same problem as the current 30-second per-start delay.

Do not introduce fragile cache hacks simply to hide Vite's normal dependency optimization behavior.

The critical requirement is:

```text
ordinary repeated `just dev` runs must be fast.
```

## 17. Required tests

After implementation, verify all of the following.

### Normal development startup

Run:

```bash
just dev
```

Let the application exit normally.

Then immediately run:

```bash
just dev
```

The second invocation must work without:

```text
Port 1420 is already in use
```

### Interrupt handling

Start:

```bash
just dev
```

then press:

```text
Ctrl+C
```

Verify port 1420 is released.

Use:

```bash
ss -ltnp | grep ':1420'
```

or equivalent.

### Changed-library startup

Modify/touch one or more books in the configured library.

Run:

```bash
just dev
```

Verify the application window appears before the expensive reconciliation finishes.

The terminal should show something equivalent to:

```text
[startup] sidecar healthy +XXXms
[startup] ...
[startup] catch-up complete ... duration=...
```

### Empty database

Verify an empty/clean database still starts normally.

### Seeded E2E

Run:

```bash
just test-e2e-seeded
```

and verify the seeded books are available according to the suite's existing expectations.

### Empty E2E

Run:

```bash
just test-e2e-empty
```

### Full checks

At minimum:

```bash
just lint
just test-rust
just test-frontend
just test-e2e
```

Run the appropriate subset while iterating, then the complete relevant validation before completion.

## 18. Acceptance criteria

The work is complete only when all of the following are true:

- `just dev` no longer routinely takes ~30 seconds before the window appears.
- Vite's readiness time is not misidentified as the application startup bottleneck.
- Normal library reconciliation does not block sidecar health/readiness.
- The window can become visible while background startup catch-up is still running.
- Startup reconciliation eventually updates the UI through existing `library-changed` events.
- Artwork-cache sweeping runs after reconciliation, not concurrently with it.
- E2E seeded-library correctness remains intact.
- Exiting `just dev` reliably terminates Vite.
- `Ctrl+C` reliably terminates Vite.
- A second immediate `just dev` does not require `fuser -k 1420/tcp`.
- Startup timestamps identify the duration of every major startup segment.
- No GPU/X11 workaround is introduced without measured evidence.
- Renderer/Vite optimization is addressed only after backend/process startup latency is measured.

## 19. Agent workflow

Work in this order:

```text
1. Reproduce the current 30-second delay.
2. Add/verify startup instrumentation.
3. Identify the exact slow segment.
4. Fix stale Vite process cleanup.
5. Move normal startup reconciliation off the critical path.
6. Preserve seeded E2E semantics.
7. Add catch-up completion logging.
8. Re-run startup measurements.
9. Investigate renderer latency only if it remains material.
10. Run the relevant test/lint suite.
```

Do not optimize based on assumptions.

The primary objective is to make the startup timeline observable and then remove the actual critical-path work.
