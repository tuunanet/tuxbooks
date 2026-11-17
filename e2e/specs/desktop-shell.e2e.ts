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
  test("brands the native window title and sidebar heading as TuxBooks", async ({
    electronApp,
    page,
  }) => {
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30000 });
    expect((await snapshot(electronApp)).title).toBe("TuxBooks");
    // The document title overrides the BrowserWindow title once the page loads; the two must agree.
    expect(await page.title()).toBe("TuxBooks");
    await expect(page.locator('[data-testid="sidebar"] h1')).toHaveText("TuxBooks");
  });

  test("launches centered, unmaximized, at the default size", async ({ electronApp }) => {
    expectDefaultSize(await snapshot(electronApp));
    expectCenteredHorizontally(await snapshot(electronApp));
  });

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
    await setBounds(electronApp, { width: 1280, height: 820 });
  });

  test("scales the Settings window with the app window", async ({ electronApp, page }) => {
    // Playwright reports no viewport for Electron pages; vw/vh resolve against the renderer's inner size.
    const viewport = () =>
      page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    // Read offsetWidth/height, not boundingBox(): the compositor box lags layout during the open animation and resize.
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
    await setBounds(electronApp, { width: 1280, height: 820 });
  });

  // The drag offset is stored in pixels and clamped only when a drag starts, so a
  // shrinking window (maximize, drag to a corner, restore) can push the panel out of
  // view; the rendered position must stay inside whatever viewport the window has.
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

    // The poll after the drag proves the pointer moved the panel, so the assertions cannot pass vacuously.
    const before = (await panelBox())!;
    await page.mouse.move(before.x + before.width / 2, before.y + 24);
    await page.mouse.down();
    await page.mouse.move(24, 24, { steps: 5 });
    await page.mouse.up();
    await expect
      .poll(async () => (await panelBox())?.x ?? Number.POSITIVE_INFINITY)
      .toBeLessThan(before.x - 100);

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
    await setBounds(electronApp, { width: 1280, height: 820 });
  });

  // Without a WM the maximize/restore cycle is a no-op; the resize is asserted on its own.
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

  // In dev/E2E appIconPath() resolves from the main bundle's entry path; the canonical asset must exist there.
  test("resolves the application icon from the canonical source", async ({ electronApp }) => {
    const entry = await electronApp.evaluate(() => process.argv[1]);
    expect(entry).toBe(appEntryPoint);
    const devIcon = entry.replace(/main\.cjs$/, "../../build/icons/512x512.png");
    expect(fs.existsSync(devIcon)).toBe(true);
  });

  test("relaunches into the default window state after a maximized session", async ({
    electronApp,
  }) => {
    // With a WM the window is genuinely maximized at close; the relaunch must be the default either way.
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
