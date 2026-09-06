# Confirming comment for WebKit bug 315997

Ready-to-paste independent confirmation for
[bug 315997 — DisplayRefreshMonitor falls back to Timer on Wayland, capping
all WebKitGTK apps at ~30fps](https://bugs.webkit.org/show_bug.cgi?id=315997)
(status NEW, P2, unconfirmed and inactive since filing on 2026-06-01). To
send it: log in to bugs.webkit.org, open the bug, "Add a comment", and paste
the text from the fenced block below verbatim — it is plain text by design
(no markdown; Bugzilla renders comments as plain paragraphs, so tables and
`**bold**` would paste as literal noise). CC yourself to track triage.

Filing this as a comment rather than a new bug: the report already matches
our environment (KWin Wayland, AMD radeonsi, GTK 4.22, "VBlank type:
Timer"). What the comment adds: independent confirmation on a second AMD
APU, WebKitGTK 2.52.3 **and** 2.52.6 across both the GTK3 (4.1) and GTK4
(6.0) API stacks, and exclusions the original report doesn't cover
(software compositing, XWayland, AC power, continuous-damage cadence,
Firefox control on the same session).

## Comment text (copy everything inside the fence)

```text
Independently confirmed on a second AMD APU with the same KWin/Wayland
+ radeonsi stack, plus an exclusion matrix that may help triage.

Method: requestAnimationFrame interval sampling, two samplers running
side by side: a self re-registering rAF loop, and one rAF registered
from an 8 ms interval (registering from a 16 ms timer beats against
16.7 ms frames and biases intervals to double). p50/p95 over ~20 s per
run, page otherwise static. "Bare host" means a plain GTK window whose
only child is the web view - no browser UI, no other code.

Results, rAF p50/p95 in ms:

* GTK3 bare host, webkit2gtk 4.1 API, WebKitGTK 2.52.3, native
  Wayland, maximized on 3840x2160@60 (KDE scale 1.45), dpr 2:
  idle 32/33
* same GTK3 host, windowed 1920x1080 CSS, dpr 2:
  idle 32/33
* same GTK3 host, GDK_BACKEND=x11 (XWayland), dpr 1.44999:
  idle 32/33
* same GTK3 host, WEBKIT_DISABLE_COMPOSITING_MODE=1, i.e. software
  compositing, dpr 2:
  idle 32/33
* GTK4 bare host, WebKit 6.0 API, WebKitGTK 2.52.6 distro build,
  native Wayland, dpr 2:
  idle 32/33
* Firefox on the same session and window geometry (XWayland,
  fractional-scale aware), dpr 1.4634:
  idle 17/17.2

Additional data points:

* Continuous per-frame damage (rAF-driven transform animation, new
  damage every frame) still does not reach 60 Hz: p50 43 ms, p95 70.
  The cap is not limited to the idle/no-damage case.
* Machine on AC power (upower reports the battery fully charged), so
  this is not low-power throttling.
* A production Tauri 2.11.5 / wry 0.55.1 app (WebKitGTK 2.52.3) with
  the same sampler gives idle p50 32 ms and continuous-scroll drag
  p50 42-44 ms - every WebKitGTK embedder on this machine sees the
  same ceiling.
* DMABUF renderer on/off A/B on that app changes raster throughput
  dramatically but not the idle cadence (~32 ms either way),
  consistent with the fallback not being GL-path related - same
  conclusion as the software-compositing row above.

Environment:
GPU         AMD Radeon 680M (rembrandt, radeonsi, ACO)
Mesa        26.0.8
Compositor  KWin / Plasma 6.6.6, Wayland session
Kernel      7.0.0
GTK         3.24.52 and 4.22.4
WebKitGTK   2.52.3 (GTK3 4.1 API) and 2.52.6 (GTK4 6.0 API)
Display     single active DP-1 3840x2160@60 at KDE fractional scale
            1.45; clients without wp_fractional_scale_v1 get integer
            scale 2, so the maximized window is 2648x1408 logical px.
            Internal eDP panel 2560x1600@165 connected but disabled
            during all runs.

Happy to test patches or a newer 2.53.x build on this hardware if
useful.
```
