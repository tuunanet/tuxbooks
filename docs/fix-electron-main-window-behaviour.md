# TuxBooks Further Development Plan — Desktop Window, Branding & Application Identity

**Target:** `tuunanet/tuxbooks`
**Primary development branch:** `fix/electron-main-window-behaviour`

This plan addresses the current desktop-shell issues visible in the supplied screenshots and the corresponding Electron implementation. The goal is to make TuxBooks behave like a normal polished desktop application before adding further reader/library features.

The current Electron main process already has explicit window-state persistence and creates the `BrowserWindow` with `show: false`, a `1100 × 720` default, and persisted `x/y/width/height/maximized` state. The renderer sidebar currently displays lowercase `tuxbooks`. Electron packaging already contains a complete TuxBooks icon set under `build/icons`, and electron-builder already points Linux packaging at that icon directory.

---

## 1. Objectives

Fix the desktop shell so that:

1. The application is consistently branded **TuxBooks**, not `tuxbooks`.
2. The native window title is **TuxBooks**.
3. The sidebar application identity is **TuxBooks**.
4. TuxBooks launches in a sensible, centered, non-maximized default size.
5. Launching the application does not unexpectedly inherit a maximized/full-screen state.
6. Restoring and resizing the window behaves like a normal Linux desktop application.
7. The window can always be resized using the normal native window borders/corners when it is not maximized.
8. Maximize → restore → resize works reliably.
9. The existing TuxBooks application icon is actually used by the Electron window/application.
10. Packaged Linux builds, development mode, and automated Electron tests use the same desktop identity.
11. Automated Playwright/Electron coverage prevents these regressions from returning.

---

# 2. Important architectural principle

Do **not** solve this by building a custom HTML/CSS title bar.

The current application already uses a normal framed Electron `BrowserWindow`, which is exactly what we want for standard Linux desktop behavior. The native frame should remain responsible for:

- title bar
- minimize
- maximize/restore
- close
- native drag behavior
- native window resizing
- compositor/window-manager integration

Electron explicitly exposes native `BrowserWindow` properties such as `title`, `icon`, `width`, `height`, `minWidth`, `minHeight`, and `center`. ([GitHub][1])

The objective is therefore to make the existing native window configuration correct rather than introducing another window-management layer.

---

# 3. Branding cleanup

## 3.1 Native window title

Change:

```ts
title: "tuxbooks",
```

to:

```ts
title: "TuxBooks",
```

The native title should be **TuxBooks** everywhere the operating system obtains the window title.

The Electron API explicitly distinguishes the native window title from the web-page title, so do not rely on React/document metadata to fix the OS title. ([GitHub][1])

### Acceptance criteria

When the application is running:

- the Linux title bar says `TuxBooks`
- no visible native window title says `tuxbooks`
- opening a reader must not change the title unexpectedly unless a future feature intentionally introduces document titles

---

## 3.2 Sidebar branding

In:

```text
frontend/src/components/layout/Sidebar.tsx
```

change:

```tsx
<h1 className="text-lg font-semibold">tuxbooks</h1>
```

to:

```tsx
<h1 className="text-lg font-semibold">TuxBooks</h1>
```

The secondary text should remain:

```text
Local ebook library
```

unless later branding work changes it.

The desired result is:

```text
TuxBooks
Local ebook library
```

not:

```text
tuxbooks
Local ebook library
```

---

# 4. Separate display branding from technical identifiers

Do **not** indiscriminately rename every occurrence of `tuxbooks`.

There are multiple technical identifiers that should remain stable:

```text
com.tuxbooks.app
tuxbooks.desktop
tuxbooks.db
tuxbooks://
```

Those are implementation/package identifiers, not visible branding.

For this task establish this rule:

| Purpose                       | Desired value        |
| ----------------------------- | -------------------- |
| Human-facing application name | `TuxBooks`           |
| Native window title           | `TuxBooks`           |
| Sidebar heading               | `TuxBooks`           |
| Electron product name         | `TuxBooks`           |
| App ID                        | `com.tuxbooks.app`   |
| Desktop filename              | `tuxbooks.desktop`   |
| Custom protocol               | `tuxbooks://`        |
| Database path                 | existing stable path |
| npm/package technical name    | `tuxbooks`           |

Changing technical identifiers unnecessarily could break installation paths, persisted user data, protocol registration, or upgrade behavior.

---

# 5. Redesign window startup behavior

## Problem

The current code persists:

```ts
interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}
```

and restores that state on launch. It also explicitly does:

```ts
if (state.maximized) window.maximize();
else window.show();
```

That means a previous maximized state can effectively become the application's next startup state.

This is directly contrary to the desired startup behavior.

The screenshot sequence demonstrates the resulting UX problem: the application can remain in a maximized state and the restore/resize interaction does not feel like normal desktop application behavior.

---

# 6. New startup policy

For this development stage, use a **deterministic sensible default window**, rather than restoring arbitrary historical window state.

Recommended default:

```text
width: 1280
height: 820
center: true
show: false
resizable: true
maximizable: true
minimizable: true
```

The exact dimensions can be adjusted after testing on the primary development display, but the important behavior is:

> Every fresh TuxBooks launch starts centered, non-maximized, at a useful reading/library size.

Electron supports `center`, explicit `width`/`height`, minimum dimensions, and standard resizable window behavior directly through `BrowserWindow`. ([GitHub][1])

### Suggested initial configuration

```ts
const window = new BrowserWindow({
  width: 1280,
  height: 820,
  center: true,
  title: "TuxBooks",
  resizable: true,
  maximizable: true,
  minimizable: true,
  show: false,
  ...
});
```

Do not call:

```ts
window.maximize();
```

during normal application startup.

---

# 7. Decide what to do with `window-state.json`

The existing state persistence should no longer control startup maximization or arbitrary dimensions.

The agent should evaluate one of these implementations, preferring the first:

### Preferred

Remove window-state persistence entirely for now.

This is the cleanest solution because the user explicitly wants a predictable good-size window every time the application starts.

Remove:

```text
WindowState
DEFAULT_STATE
windowStateFile()
loadWindowState()
saveWindowState()
```

and all related persistence listeners.

### Acceptable alternative

Keep persistence only for future compatibility, but make launch policy:

```text
always start with default width/height
always start centered
always start unmaximized
```

and do not restore persisted `maximized`, `x`, `y`, `width`, or `height`.

Do **not** retain a code path which can silently reopen TuxBooks maximized.

---

# 8. Fix native resize behavior

This is the most important part of the reported UX problem.

The expected behavior should be:

### Normal window

- cursor at left/right/top/bottom borders → resize cursor
- cursor at corners → diagonal resize cursor
- drag border → window resizes
- drag corner → width and height change together

### Maximized window

- borders are not resize handles
- native maximize/restore control restores the window
- after restore, resize handles immediately work again

### Maximize → restore sequence

The following exact workflow must be tested:

```text
Launch TuxBooks
↓
Normal centered window
↓
Maximize
↓
Click maximize/restore button
↓
Normal window
↓
Move pointer to bottom-right corner
↓
Resize window
```

The last step must work without restarting the application.

---

# 9. Investigate the Linux-specific window-manager interaction

Do not assume the resize problem is purely a React/CSS problem.

The current `BrowserWindow` does not intentionally disable resizing, so the agent must verify what Electron actually creates at runtime.

Investigate:

```ts
resizable;
maximizable;
minimizable;
fullscreen;
fullscreenable;
frame;
titleBarStyle;
titleBarOverlay;
```

and verify there is no CSS/renderer element accidentally intercepting native window-edge interaction.

Electron's documentation notes that Wayland has special limitations around programmatic window movement/resizing; therefore the implementation and test strategy must distinguish **user-driven native resize** from programmatic resizing. ([GitHub][1])

Do not introduce X11-specific workarounds unless testing demonstrates an actual Wayland limitation.

---

# 10. Add sensible minimum dimensions

The library UI currently has a fixed sidebar plus the main content area. The reader will also require a reasonable viewport.

Add minimum dimensions such as:

```ts
minWidth: 900,
minHeight: 600,
```

or another empirically justified value.

The agent should test the minimum dimensions against:

- library view
- sidebar
- book detail
- reader
- settings
- dialogs/overlays

The application must never reach a state where the main UI becomes unusable because the native window can be shrunk too far.

---

# 11. Window visibility/startup sequencing

The existing startup intentionally uses:

```ts
show: false;
```

and waits for:

```ts
ready - to - show;
```

before showing the window. That behavior should be retained because it avoids displaying an obviously incomplete window.

However, simplify the final startup sequence so that it is conceptually:

```text
Electron ready
→ sidecar ready
→ BrowserWindow created
→ renderer loaded
→ ready-to-show
→ show centered normal window
```

There should be no:

```text
load persisted state
→ discover previous maximized state
→ maximize window
→ show
```

path.

---

# 12. Application icon integration

This part is particularly straightforward because the project already contains the icon assets.

The repository already contains:

```text
build/icons/32x32.png
build/icons/64x64.png
build/icons/128x128.png
build/icons/256x256.png
build/icons/512x512.png
build/icons/icon.png
```

and electron-builder already configures:

```yaml
linux:
  icon: build/icons/
```

so packaging already knows where the icon assets live.

The missing piece is using the icon for the actual Electron window/application runtime.

---

# 13. Add Electron `BrowserWindow` icon

Add an explicit icon to the `BrowserWindow`.

Do not hardcode a path that only works from the repository root.

The main process already documents that its bundled `__dirname` is `electron/dist`, so resolve the icon relative to the packaged application structure.

The agent should determine the correct packaged/dev path and create one reusable helper, for example:

```ts
function appIconPath(): string {
  ...
}
```

The helper should work in:

- development
- packaged Linux build
- Playwright/E2E test environment

The resulting configuration should be conceptually:

```ts
icon: appIconPath(),
```

Electron's `BrowserWindow` supports an `icon` property for the native window. ([GitHub][1])

---

# 14. Use one canonical application icon source

Do not duplicate the artwork.

Use:

```text
build/icons/
```

as the canonical packaged icon source.

If another renderer-visible icon is eventually needed, create an intentional reference/copy from this source rather than allowing multiple unrelated versions of the TuxBooks logo.

The existing icon files should first be visually inspected to ensure they are actually the desired TuxBooks application icon.

---

# 15. Update electron-builder product branding

The current packaging config contains:

```yaml
productName: tuxbooks
```

Change the human-facing packaging name to:

```yaml
productName: TuxBooks
```

while retaining:

```yaml
appId: com.tuxbooks.app
```

Do not change the App ID.

The current configuration already defines the Linux package metadata and icon directory.

The agent should verify that changing `productName` does not unintentionally alter paths or upgrade behavior.

---

# 16. Desktop integration acceptance criteria

A packaged Linux build should show **TuxBooks** consistently in:

- window title
- desktop/application launcher
- application/taskbar representation
- package metadata where human-readable
- application icon

The agent should inspect at least:

```text
.deb
AppImage
rpm
```

where practical.

---

# 17. Playwright/Electron regression tests

This work should be treated as a desktop-shell regression suite, not manually validated once.

Add Playwright Electron tests for:

### Test A — branding

Verify:

```text
native window title === "TuxBooks"
sidebar heading === "TuxBooks"
```

### Test B — initial window geometry

On launch:

```text
window is not maximized
width is within expected default range
height is within expected default range
window is positioned approximately in the center of the primary display
```

Do not make the test dependent on one exact pixel coordinate if the OS/window-manager introduces frame offsets.

Use tolerances.

### Test C — maximize

```text
launch
→ maximize
→ verify maximized
```

### Test D — restore

```text
launch
→ maximize
→ restore
→ verify !maximized
```

### Test E — resize after restore

This test is critical.

```text
launch
→ maximize
→ restore
→ resize window
→ verify bounds changed
```

### Test F — repeated launch

```text
launch
→ maximize
→ close
→ launch again
→ verify normal centered default state
```

This catches the current persisted-maximized-state problem.

### Test G — minimum size

Attempt to resize below the configured limits and verify that the window does not become smaller than the minimum.

### Test H — icon

For the runtime environment, verify as much of the native icon behavior as Playwright/Electron APIs permit. For packaged artifacts, add a packaging-level verification where practical.

---

# 18. Manual Linux verification matrix

Because the issue is specifically a desktop-window behavior problem, the agent must not rely exclusively on DOM assertions.

Perform manual validation on the target Linux environment:

| Scenario                         | Expected               |
| -------------------------------- | ---------------------- |
| First launch                     | Centered normal window |
| Move window                      | Works normally         |
| Drag right edge                  | Resizes                |
| Drag bottom edge                 | Resizes                |
| Drag bottom-right corner         | Resizes both axes      |
| Maximize                         | Fills desktop          |
| Restore                          | Returns to normal size |
| Resize immediately after restore | Works                  |
| Close + reopen                   | Starts normal/centered |
| Application icon                 | TuxBooks icon visible  |
| Window title                     | TuxBooks               |

Also test with the actual desktop environment used for development, including Wayland where applicable.

---

# 19. Avoid overengineering

Do **not**:

- build a custom title bar
- create JavaScript resize handles
- implement custom maximize/restore buttons
- manipulate window dimensions from React
- introduce a window-management library
- add platform-specific hacks before reproducing the problem
- rename technical identifiers unnecessarily

The desired end state is a small amount of correct Electron configuration backed by native window-manager behavior.

---

# 20. Suggested implementation order

### Phase 1 — Branding

1. Change Electron title to `TuxBooks`.
2. Change sidebar heading to `TuxBooks`.
3. Change electron-builder `productName` to `TuxBooks`.
4. Audit visible lowercase `tuxbooks` occurrences and classify each as human-facing vs technical.

### Phase 2 — Window lifecycle

5. Remove startup dependence on persisted window geometry.
6. Set deterministic default dimensions.
7. Center the window.
8. Ensure startup is always unmaximized.
9. Add `minWidth` / `minHeight`.
10. Keep the normal native framed BrowserWindow.

### Phase 3 — Resize/restore validation

11. Verify native `resizable` behavior.
12. Verify maximize/restore.
13. Verify resize after restore.
14. Test under the actual Linux desktop environment.
15. Only investigate platform-specific workarounds if native behavior still fails.

### Phase 4 — Icon

16. Add explicit `BrowserWindow` icon.
17. Make icon-path resolution work in dev, test, and packaged environments.
18. Ensure electron-builder uses the same icon set.
19. Verify launcher/window/taskbar appearance.

### Phase 5 — Regression coverage

20. Add Playwright tests for startup state.
21. Add maximize/restore/resize regression test.
22. Add repeated-launch regression test.
23. Add branding assertions.
24. Add packaging verification.

---

# 21. Definition of done

This task is complete only when the following statement is true:

> TuxBooks launches every time as a centered, normal-sized, resizable desktop window with the TuxBooks icon and `TuxBooks` branding. Maximizing and restoring behaves like a normal native desktop application, and immediately resizing the restored window works correctly. Restarting the application does not unexpectedly reopen it maximized or at an unusable size.

The current code already has much of the infrastructure needed; the primary corrective change is to simplify the native window lifecycle rather than adding another abstraction. The existing persisted `maximized` state is the key behavior that should be removed or made non-authoritative.

### Handover instruction to the coding agent

**Implement this plan directly on the current TuxBooks Electron branch. Before changing code, inspect the existing Electron window lifecycle, packaging configuration, icon assets, and Playwright/Electron test harness. Preserve stable technical identifiers such as `com.tuxbooks.app` and `tuxbooks://`. After implementation, run the full lint/typecheck/test/build path and explicitly execute the maximize → restore → resize scenario. Do not consider the task complete based only on DOM tests; verify actual native window behavior.**

[1]: https://github.com/electron/electron/blob/main/docs/api/browser-window.md?utm_source=chatgpt.com "electron/docs/api/browser-window.md at main · electron/electron · GitHub"
