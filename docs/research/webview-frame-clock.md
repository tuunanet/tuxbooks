# Webview frame clock and dpr fiction — findings

Answers the two open questions from
`docs/research/reader-perf-bench-handover.md` (2026-09-06, same session as the
`just bench-reader` baseline quoted below). Investigation-only round: no app
code changed. Environment: Kubuntu Wayland (KWin), AMD + Mesa, WebKitGTK
2.52.3 (user-local, what the app links/loads via `scripts/dev-env.sh`) and
2.52.6 (system), KDE scale **1.45** on the active **DP-1 3840×2160@60**
output (logical 2649×1490; internal eDP-1 2560×1600@165 connected but
disabled — the handover's "4K panel @ 60 Hz" is DP-1).

## Verdict 1 — the ~31 fps idle ceiling is WebKitGTK engine-level

A minimal probe page (rAF samplers: self re-registering loop + one registered
from an 8 ms interval, per the bench-harness lessons) run in bare hosts, all
maximized on DP-1 unless noted:

| Host                                        | Stack                                  | dpr reported | idle p50/p95 (ms) | damage p50/p95 (ms)              |
| ------------------------------------------- | -------------------------------------- | ------------ | ----------------- | -------------------------------- |
| Host A                                      | GTK3 + WebKitGTK 4.1 (2.52.3), Wayland | 2            | 32/33             | 43/70                            |
| Host A, windowed 1920×1080                  | same                                   | 2            | 32/33             | —                                |
| Host A, `GDK_BACKEND=x11`                   | same, XWayland                         | **1.44999**  | 32/33             | —                                |
| Host A, `WEBKIT_DISABLE_COMPOSITING_MODE=1` | software compositing                   | 2            | 32/33             | —                                |
| Host B                                      | GTK4 + WebKitGTK 6.0 (2.52.6), Wayland | 2            | 32/33             | —                                |
| Firefox (snap)                              | Gecko, XWayland, fractional-aware      | **1.4634**   | **17/17.2**       | —                                |
| App (`just bench-reader`, same session)     | tauri 2.11.5 / wry 0.55.1, Wayland     | 2            | 32/33             | pdf drag 44/65 · epub drag 42/45 |

Readings:

- The app, wry/Tauri, the GTK major, the GDK backend, the GL compositing
  path, and DMABUF (prior A/B) are **all excluded** — a 40-line GTK host
  with none of them reproduces 32 ms idle exactly.
- With continuous damage (animated transform) Host A presents at 43 ms p50 —
  the same number as the app's drag scenarios. The handover's "~11 ms drag
  delta over idle" is the difference between WebKitGTK's idle and damaged
  presentation modes, not app raster cost.
- Firefox runs the full 60 Hz on the same session, output, and window size —
  KWin, the driver, and the display path deliver 60 Hz to other engines.
- Machine on AC (`upower`: fully-charged) — WebKit low-power throttling is
  not the explanation.

**Conclusion:** root-caused at the WebKitGTK level and already reported
upstream as [bug 315997 — "DisplayRefreshMonitor falls back to Timer on
Wayland, capping all WebKitGTK apps at ~30fps"](https://bugs.webkit.org/show_bug.cgi?id=315997)
(NEW/P2, unconfirmed since 2026-06-01). The original report matches this
environment (KWin + AMD radeonsi + GTK 4.22, `about:support` shows
"VBlank type: Timer"). A ready-to-paste confirming comment with this
matrix is in `docs/research/webkit-bug-315997-comment.md` — post it once
logged in to bugs.webkit.org. No app-side change can lift the ceiling.

**2.53.92 is a partial fix (2026-09-06):** the old web-process
`DisplayRefreshMonitorGtk` (the subject of bug 315997) is gone, replaced
by a UI-process `DisplayVBlankMonitor`/`DisplayLink` that feeds the web
process over IPC. That link ticks at 61 Hz and the web process receives
the refresh at 60 Hz **in every environment tested** — including natively.
But rAF only reaches 60 Hz **inside containers**: a bare host against
WebKitGTK 2.53.92 runs idle p50/p95 16/17 ms and 17/18 ms under damage
in both a Debian sid and an Ubuntu 26.04 container (libraries, env vars,
sandbox, dbus/UPower, CPU/memory pressure, timer slack, namespaces,
seccomp and reduced-motion all A/B-excluded). Natively in the KDE
session the **same** bits lock at idle 32/33 ms (every-other-tick) — the
web process's rendering-update/frame-confirmation loop only completes
every second display link tick there, while the UI display link keeps
ticking at 61 Hz (VBlankMonitor thread nanosleep 16.3 ms median; UI main
thread timers ~30 ms native vs ~12 ms container is the one residual
scheduling difference found). `just bench-reader` on 2.53.92 confirms the
app is unchanged natively (idle 32/33, drag p50 45–50, walk p95 588).
So: 2.53/2.54 fixes the _architecture_ but a residual environmental
interaction still caps a native desktop session at ~30 fps — re-test
2.54.0 when it lands, but do not assume it is fixed on this machine.

## Verdict 2 — dpr 2 is fiction; the true compositor scale is 1.45

- `kscreen-doctor -o`: DP-1 scale **1.45**, logical 2649×1490. The maximized
  webview CSS size 2648×1389–1408 matches the workarea exactly.
- GTK3 (and GTK4 here) clients do not support `wp_fractional_scale_v1`;
  KWin advertises the integer scale **2**, the webview buffers at 2×
  (5296 px wide), and KWin downscales by 1.45/2 — the "geometrically
  impossible" 2648 CSS @ dpr 2 on a 3840 panel from the handover.
- Under `GDK_BACKEND=x11` the same host sees the physical X window
  (`outer 3840×2041`, `screen 3840×2160`) and computes dpr = 3840/2648 =
  **1.44999**. Firefox (fractional-aware) reports **1.4634** (= 3840/2624,
  KDE's X legacy rounding). Three independent paths agree the true scale is
  ~1.45.
- Consequence of the fiction at equal logical size: buffers are rasterized
  (2/1.45)² ≈ **1.90× larger than native** and downscaled by the compositor.

### Why no clamp was implemented (decision)

The obvious fix — bound the ratio entering `pdfRenderPolicy` by the true
scale — was ruled out with bench evidence:

1. **At reference conditions it changes nothing.** The bench baseline shows
   fit-width buffers already capped at the 2²⁴ soft tier (bufferPx
   16,774,659, ratio ≈ 1.37) — **below** the true 1.45 scale. The soft tier,
   not the reported dpr, governs fit-width raster; today's buffers are ~10%
   under-native (slightly soft), not oversampled. The 1.90× waste exists
   only in the gap between the soft tier and dpr under zoom, where the hard
   2²⁵ cap already bounds the worst case.
2. **There is no page-side truth channel.** The compositor's fractional
   value is invisible from inside a non-fractional-aware Wayland client;
   both backends lie differently (Wayland says 2, X11 says 1.45). Any clamp
   value would be a user-supplied guess — config surface with no verifiable
   default, for a payoff (1) shows is ~zero at reference conditions.
3. The frame-clock ceiling dominates every smoothness metric; raster size
   only feeds PERF-2's wall clock, which stays uncalibrated until the
   ceiling is resolved upstream (handover open question 3, unchanged).

If zoom-time raster ever needs it, the honest mechanism is an explicit
opt-in override (env or preference) documented against measured zoom
numbers — revisit together with the render-cap re-tier lever.

## What this changes in the handover's lever list

- Lever 1 (resolve the ceiling): **confirmed upstream** as
  [bug 315997](https://bugs.webkit.org/show_bug.cgi?id=315997) (timer
  fallback caps rAF at ~30 Hz on Wayland). Action: post the confirming
  comment (`docs/research/webkit-bug-315997-comment.md`), then track
  triage/fix; re-bench when a fixed WebKitGTK reaches this machine.
- Lever 2 (geometry anomaly): **resolved — no-op** (see decision above).
- Levers 3–5 (EPUB bounded measure, render-cap re-tier, PERF-2
  re-calibration): unchanged, still gated on the clock.

## Appendix — probe sources

Probe page (both samplers; a `raf-probe-damage` variant adds a per-rAF
animated transform; the net variant reports via form POST to a local sink so
non-executable browsers like Firefox can be measured):

```html
<script>
  var loop = [],
    tick = [],
    lastLoop = performance.now();
  function step(t) {
    loop.push(t - lastLoop);
    lastLoop = t;
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
  var lastTick = null;
  setInterval(function () {
    requestAnimationFrame(function (t) {
      if (lastTick !== null && t > lastTick) tick.push(t - lastTick);
      lastTick = t;
    });
  }, 8);
  window.__probeResults = function () {
    /* p50/p95 of both + inner/outer/screen/dpr */
  };
</script>
```

Hosts (both load the page maximized and poll `__probeResults` every 2 s to
stdout):

- **Host A** (matches the app stack): scratch cargo crate, `gtk = "0.18.2"`,
  `webkit2gtk = { version = "2.0.2", features = ["v2_22"] }`. API notes that
  cost time: use `glib::timeout_add_seconds_local` (the `Send` variant
  rejects closures holding a `WebView`); `run_javascript` takes
  `None::<&webkit2gtk::gio::Cancellable>`; `JavascriptResult::js_value()`
  needs the `v2_22` crate feature; delete-event returns
  `glib::Propagation`. Needs `scripts/dev-env.sh`'s `PKG_CONFIG_PATH`/
  `LD_LIBRARY_PATH` on sudo-less machines.
- **Host B** (engine check on GTK4): PyGObject,
  `gi.require_version('WebKit', '6.0')`; `evaluate_javascript` takes six
  positional args (script, length, world, source_uri, cancellable, callback).
