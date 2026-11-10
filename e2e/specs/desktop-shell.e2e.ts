import fs from "node:fs";

import {
  expect,
  launchElectronApp,
  test,
  type ElectronApplication,
} from "../fixtures/electron-app.js";
import { appEntryPoint } from "../setup/fixtures.js";

/**
 * Desktop-shell regression suite: branding, deterministic startup geometry,
 * min-size clamping, Settings-window scaling and visibility,
 * resize-after-maximize/restore, icon resolution, and the repeated-launch
 * policy — the window-lifecycle behaviors that must never regress.
 *
 * Its own Playwright phase ("shell", e2e/package.json test:shell): the
 * relaunch scenario closes and relaunches the app, which only works when
 * this file owns the worker's app exclusively (workers are reused across
 * spec files; closing the shared app would break whoever runs next).
 *
 * Window-manager reality check: a true maximize/restore is an EWMH
 * round-trip with the WM. Headless runs use a bare Xvfb with NO window
 * manager, where Electron's maximize() is a documented no-op (probed: the
 * request is sent, nothing answers). Those scenarios detect the missing WM
 * and skip with a notice instead of asserting false things; they run fully
 * under the headed recipes (`just test-e2e-headed-shell` on a real desktop)
 * where the developer's WM participates. Resize itself (setBounds) is WM-
 * independent and is always asserted.
 */

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WindowSnapshot {
  bounds: Rect;
  maximized: boolean;
  resizable: boolean;
  title: string;
  workArea: Rect;
}

/** One main-process round trip: the first window's native state. */
function snapshot(electronApp: ElectronApplication): Promise<WindowSnapshot> {
  return electronApp.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return {
      bounds: win.getBounds(),
      maximized: win.isMaximized(),
      resizable: win.isResizable(),
      title: win.getTitle(),
      workArea: screen.getPrimaryDisplay().workArea,
    };
  });
}

function maximize(electronApp: ElectronApplication): Promise<void> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].maximize();
  });
}

function unmaximize(electronApp: ElectronApplication): Promise<void> {
  return electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].unmaximize();
  });
}

function setBounds(electronApp: ElectronApplication, bounds: Partial<Rect>): Promise<void> {
  return electronApp.evaluate(({ BrowserWindow }, bounds) => {
    BrowserWindow.getAllWindows()[0].setBounds(bounds);
  }, bounds);
}

/**
 * Request maximize and report whether the environment actually honored it
 * (state flipped within a bounded wait). Does NOT restore: the maximized
 * state is the point of the callers — skip-without-WM and the relaunch test.
 */
async function maximizeIfSupported(electronApp: ElectronApplication): Promise<boolean> {
  await maximize(electronApp);
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if ((await snapshot(electronApp)).maximized) return true;
  }
  return false;
}

/**
 * XWayland/window managers inflate the reported outer bounds by frame
 * extents (mutter adds 4px) — the policy under test is the SIZE and
 * POSITION, not WM chrome pixels (§17: use tolerances, not exact pixels).
 */
const FRAME_TOLERANCE_PX = 16;

function expectCenteredHorizontally(snap: WindowSnapshot): void {
  // Tolerance, not pixels: WM frame offsets shift x by a few pixels; the
  // policy (centered launch) is what must hold.
  const windowCenterX = snap.bounds.x + snap.bounds.width / 2;
  const workAreaCenterX = snap.workArea.x + snap.workArea.width / 2;
  expect(Math.abs(windowCenterX - workAreaCenterX)).toBeLessThan(100);
}

function expectDefaultSize(snap: WindowSnapshot): void {
  expect(snap.maximized).toBe(false);
  expect(snap.resizable).toBe(true);
  expect(Math.abs(snap.bounds.width - 1280)).toBeLessThanOrEqual(FRAME_TOLERANCE_PX);
  expect(Math.abs(snap.bounds.height - 820)).toBeLessThanOrEqual(FRAME_TOLERANCE_PX);
}

test.describe("TuxBooks desktop shell", () => {
  // Test A — branding: the native title bar and the sidebar identity.
  test("brands the native window title and sidebar heading as TuxBooks", async ({
    electronApp,
    page,
  }) => {
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30000 });
    expect((await snapshot(electronApp)).title).toBe("TuxBooks");
    // The document title would override the BrowserWindow title once the
    // page loads — the two must agree.
    expect(await page.title()).toBe("TuxBooks");
    await expect(page.locator('[data-testid="sidebar"] h1')).toHaveText("TuxBooks");
  });

  // Test B — deterministic startup geometry: centered, unmaximized, default
  // size — on every launch, with no persisted state in the loop.
  test("launches centered, unmaximized, at the default size", async ({ electronApp }) => {
    expectDefaultSize(await snapshot(electronApp));
    expectCenteredHorizontally(await snapshot(electronApp));
  });

  // Test G — minimum dimensions: the window never shrinks below the
  // configured limits (Electron enforces this itself, WM or not), and the
  // clamp lands at the minimum, not below or (far) above it.
  test("never shrinks below the minimum dimensions", async ({ electronApp }) => {
    await setBounds(electronApp, { width: 400, height: 300 });
    await expect
      .poll(
        async () => {
          const { bounds } = await snapshot(electronApp);
          return bounds.width >= 900 && bounds.height >= 600;
        },
        { timeout: 5000 },
      )
      .toBe(true);
    const { bounds } = await snapshot(electronApp);
    expect(bounds.width).toBeLessThanOrEqual(900 + FRAME_TOLERANCE_PX);
    expect(bounds.height).toBeLessThanOrEqual(600 + FRAME_TOLERANCE_PX);
    // Leave the default geometry for the following tests.
    await setBounds(electronApp, { width: 1280, height: 820 });
  });

  // Settings-window scaling: the panel tracks the app window instead of
  // staying at one fixed size (it used to be 920x680 at any window size).
  // A bigger window grows it substantially, and it stays a floating panel
  // with a visible gutter rather than going full-bleed. The thresholds are
  // loose bounds on that contract, not the sizing formula.
  test("scales the Settings window with the app window", async ({ electronApp, page }) => {
    // Playwright reports no viewport for Electron pages; the renderer's own
    // inner dimensions are what vw/vh resolve against.
    const viewport = () =>
      page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    // The layout box, not boundingBox(): that reports the compositor's
    // visual box, which lags behind layout during the open animation and
    // right after a window resize (surface scaling).
    const panel = () =>
      page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-testid="settings-window"]');
        return el ? { width: el.offsetWidth, height: el.offsetHeight } : null;
      });

    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30000 });
    await setBounds(electronApp, { width: 1280, height: 820 });
    await expect.poll(async () => (await viewport()).width).toBe(1280);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByTestId("settings-window")).toBeVisible();
    const atDefault = (await panel())!;

    await setBounds(electronApp, { width: 1800, height: 1000 });
    await expect.poll(async () => (await viewport()).width).toBe(1800);
    await expect.poll(async () => (await viewport()).height).toBe(1000);
    // The renderer's layout can lag the viewport read right after a resize;
    // poll until the panel's layout reflects it (and fail here if the panel
    // never scales).
    await expect
      .poll(async () => (await panel())?.width ?? 0)
      .toBeGreaterThan(atDefault.width + 200);
    const atLarge = (await panel())!;

    expect(atLarge.height).toBeGreaterThan(atDefault.height + 50);
    const vp = await viewport();
    expect(vp.width - atLarge.width).toBeGreaterThanOrEqual(100);
    expect(vp.height - atLarge.height).toBeGreaterThanOrEqual(100);

    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.getByTestId("settings-window")).toHaveCount(0);
    // Leave the default geometry for the following tests.
    await setBounds(electronApp, { width: 1280, height: 820 });
  });

  // The drag offset is stored in pixels and was only clamped when a drag
  // started, so a shrinking window (maximize, drag to a corner, restore)
  // could push the panel out of view entirely. The rendered position must
  // stay clamped inside whatever viewport the app window currently has.
  test("keeps the Settings window in view after the app window shrinks", async ({
    electronApp,
    page,
  }) => {
    const viewport = () =>
      page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const panelBox = () => page.getByTestId("settings-window").boundingBox();

    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30000 });
    await setBounds(electronApp, { width: 1800, height: 1000 });
    await expect.poll(async () => (await viewport()).width).toBe(1800);

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByTestId("settings-window")).toBeVisible();

    // Drag the panel into the top-left corner of the big window. The poll
    // after the drag proves the pointer actually moved the panel, so the
    // assertions below cannot pass vacuously on a missed drag.
    const before = (await panelBox())!;
    await page.mouse.move(before.x + before.width / 2, before.y + 24);
    await page.mouse.down();
    await page.mouse.move(24, 24, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(async () => (await panelBox())?.x ?? Number.POSITIVE_INFINITY)
      .toBeLessThan(before.x - 100);

    // Shrink well below the size the drag offset was clamped for.
    await setBounds(electronApp, { width: 900, height: 600 });
    await expect.poll(async () => (await viewport()).width).toBe(900);
    await expect.poll(async () => (await viewport()).height).toBe(600);

    await expect
      .poll(async () => {
        const box = await panelBox();
        if (!box) return false;
        const vp = await viewport();
        return (
          box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= vp.width &&
          box.y + box.height <= vp.height
        );
      })
      .toBe(true);

    await page.getByRole("button", { name: "Close settings" }).click();
    await expect(page.getByTestId("settings-window")).toHaveCount(0);
    // Leave the default geometry for the following tests.
    await setBounds(electronApp, { width: 1280, height: 820 });
  });

  // Test E (critical) — resize after a maximize/restore cycle still works:
  // maximize → restore → resize → bounds changed. Without a WM the cycle is
  // a no-op and the resize is asserted on its own; with one, the restore
  // path is the regression this test exists for.
  test("resizes after a maximize/restore cycle", async ({ electronApp }) => {
    await maximize(electronApp);
    await unmaximize(electronApp);
    await expect
      .poll(async () => (await snapshot(electronApp)).maximized, { timeout: 5000 })
      .toBe(false);
    await setBounds(electronApp, { width: 1000, height: 700 });
    await expect
      .poll(
        async () => {
          const { bounds } = await snapshot(electronApp);
          return (
            Math.abs(bounds.width - 1000) <= FRAME_TOLERANCE_PX &&
            Math.abs(bounds.height - 700) <= FRAME_TOLERANCE_PX
          );
        },
        { timeout: 5000 },
      )
      .toBe(true);
  });

  // Test C — maximize fills the desktop (WM environments only; skipped on
  // bare Xvfb, run by the headed recipe).
  test("maximizes the window", async ({ electronApp }) => {
    test.skip(
      !(await maximizeIfSupported(electronApp)),
      "this environment has no window manager (headless Xvfb): native maximize needs a real desktop — run the headed recipe for full coverage",
    );
    expect(await snapshot(electronApp)).toEqual(
      expect.objectContaining({ maximized: true, resizable: true }),
    );
    await unmaximize(electronApp);
  });

  // Test D — the maximize/restore button's contract: back to the normal
  // state, not stuck maximized (WM environments only).
  test("restores a maximized window", async ({ electronApp }) => {
    test.skip(
      !(await maximizeIfSupported(electronApp)),
      "this environment has no window manager (headless Xvfb): native maximize needs a real desktop — run the headed recipe for full coverage",
    );
    await unmaximize(electronApp);
    await expect
      .poll(async () => (await snapshot(electronApp)).maximized, { timeout: 5000 })
      .toBe(false);
    expect((await snapshot(electronApp)).bounds.width).toBeLessThan(
      (await snapshot(electronApp)).workArea.width,
    );
  });

  // Test H — the icon the window is created with: in dev/E2E the main
  // bundle's location (the app's own entry path) is what appIconPath()
  // resolves the dev branch from, and the canonical build/icons asset must
  // exist there. (The packaged layout is verified by scripts/check-deb.sh;
  // the painted result is a headed/manual check.)
  test("resolves the application icon from the canonical source", async ({ electronApp }) => {
    const entry = await electronApp.evaluate(() => process.argv[1]);
    expect(entry).toBe(appEntryPoint);
    const devIcon = entry.replace(/main\.cjs$/, "../../build/icons/512x512.png");
    expect(fs.existsSync(devIcon)).toBe(true);
  });

  // Test F — repeated launch: maximize, close, launch again → the next
  // startup is the deterministic default, never a restored maximized state.
  // This is the regression test for the removed window-state persistence.
  test("relaunches into the default window state after a maximized session", async ({
    electronApp,
  }) => {
    // With a WM the window is genuinely maximized at close time — exactly
    // the historical persistence bug; without one the request is dropped.
    // The relaunch must be the default either way.
    const wasMaximized = await maximizeIfSupported(electronApp);
    if (wasMaximized) {
      await expect
        .poll(async () => (await snapshot(electronApp)).maximized, { timeout: 5000 })
        .toBe(true);
    }
    await electronApp.close();

    const relaunched = await launchElectronApp();
    try {
      const snap = await snapshot(relaunched);
      expectDefaultSize(snap);
      expectCenteredHorizontally(snap);
    } finally {
      await relaunched.close();
    }
  });
});
