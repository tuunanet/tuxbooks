# GPU-crash fallback

Mitigation for issue #13: the Chromium **GPU process** (`--type=gpu-process`)
crashed under Wayland/Mesa (AMD Radeon 680M, Mesa 26.0.8) while a PDF was
open. Chromium recovered it and the app kept running — but systemd recorded a
coredump for the child process.

## Diagnosis

The crash is **below the application**: the coredump is a SIGTRAP inside
Mesa's `libgallium` on the GPU-process side. TuxBooks code does not execute
in the GPU process — the renderer (including the MuPDF.js worker, which
rasterizes pages onto canvases) is a separate process, and the GPU process
only composites. A coredump for a crashed child process is OS behavior the
app cannot suppress; the app-level lever is avoiding repeated crashes and
degrading gracefully when the stack proves unstable.

Observed environment (from the issue): Ubuntu 26.04, KDE Plasma/Wayland,
AMD Radeon 680M, Mesa 26.0.8, 4K external display at 145% scaling. Large
PDF canvas surfaces under GPU compositing are the plausible stressor, not a
corrupt document — the reader's own budgets (docs/performance.md) already
bound canvas memory.

## Policy

The main process (`electron/main/gpuFallback.ts`, wired in
`electron/main/index.ts`) implements one rule with three parts:

1. **Arm** — GPU-process deaths with `reason: "crashed"` are counted per
   session (the existing `child-process-gone` handler). A
   hardware-accelerated session that reaches **2 crashes** — the
   crash → recovery → crash loop of an unstable stack, vs. one driver hiccup
   — writes a marker file `gpu-fallback.json` next to the application
   database. Chromium keeps recovering in-session; no in-session action is
   possible or needed.
2. **Degrade** — at startup, an unexpired marker disables hardware
   acceleration for that launch (`app.disableHardwareAcceleration()`, i.e.
   Chromium's `--disable-gpu`). This is the sanctioned exception to PERF-11
   ("no GPU-workaround flags without cause"): the cause is recorded in the
   marker and in the startup log line. A single crash never degrades the
   next launch.
3. **Self-heal** — a hardware-accelerated session that ends cleanly with
   zero GPU crashes proves the graphics stack works and removes the marker
   (including stale/expired files). A software-rendered session proves
   nothing and never clears it. The marker also expires after **7 days**,
   so a fixed driver is re-tried even without a stable session in between.

The marker lives next to the database (the `com.tuxbooks.app` data dir;
`TEST_DATABASE_PATH` in test/E2E environments), which keeps the isolation
rules for free. Writing it is best-effort — a read-only data dir only means
the next launch tries hardware again.

## Verification

- **Unit** (`frontend/tests/gpuFallbackPolicy.test.ts`): threshold arming,
  refresh, expiry, corrupt-marker tolerance, self-heal primitive, read-only
  degradation.
- **E2E** (`just test-e2e-gpu`, `e2e/specs/gpu-fallback.e2e.ts`): an active
  marker boots the app with `--disable-gpu` set (asserted in-process via
  `app.commandLine.hasSwitch`), reading still works in that mode (PDF page
  renders non-blank), a software session does not clear an active marker,
  and a clean hardware-accelerated session removes an expired one. The
  crash-count → arming step itself cannot be simulated deterministically
  headlessly and is covered by the unit tier.

Reading-progress integrity under a GPU failure needs no new code: progress
writes go renderer → main → sidecar → SQLite (debounced 1 s, flushed on
unmount), none of which touch the GPU process, and Chromium restores the
compositor without restarting the renderer. The reopen-restore acceptance
tests (seeded phase) pin the persistence contract.
