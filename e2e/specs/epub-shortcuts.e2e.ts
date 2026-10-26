/**
 * Keyboard shortcuts while focus is inside the EPUB content frame. The
 * shortcut provider listens on the app window; keydown in the frame never
 * reaches it, so the engine must forward the reader's combos. Regression:
 * panel shortcuts died as soon as a click landed in the text.
 *
 * Focus lands by clicking a paragraph through Playwright's frame locator,
 * which reaches into the frame's own document — no coordinate math against
 * the host page. The forwarding logic itself is unit-covered in
 * tests/epubKeyboardShortcuts.test.ts; this spec pins it to the real frame,
 * which a unit test cannot reach. An earlier version dragged a selection to
 * create a highlight first, but finding a text range to drag over was the
 * flaky part on a loaded runner and exercised the same forwarding path.
 */
import { expect, test, type Page } from "../fixtures/electron-app.js";
import { ensureLibrary, openInReader } from "./helpers.js";

const FRAME = "iframe.readium-navigator-iframe";

/** Click a paragraph inside the content frame so focus enters it. */
async function focusContentFrame(page: Page): Promise<void> {
  // `force`: Readium mounts a second frame during section swaps and it can
  // cover the first, so Playwright's actionability check rejects the click as
  // intercepted. Which frame takes focus does not matter — the engine wires
  // shortcut forwarding onto every frame it mounts.
  await page
    .frameLocator(FRAME)
    .first()
    .locator("p")
    .first()
    .click({ timeout: 30_000, force: true });
}

test("panel shortcuts work with focus inside the EPUB content frame", async ({ page }) => {
  await openInReader(page, "A Minimal Book (EPUB)");
  try {
    await expect(page.getByTestId("reader-view")).toBeVisible({ timeout: 30000 });

    await focusContentFrame(page);

    // Ctrl+Shift+H must toggle the nav drawer from inside the frame.
    await page.keyboard.press("Control+Shift+H");
    await expect(page.getByTestId("reader-nav")).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press("Control+Shift+H");
    await expect(page.getByTestId("reader-nav")).toBeHidden({ timeout: 10_000 });
  } finally {
    // The seeded phase shares one app per worker: even a failed run must
    // end in the library so the next spec's waitForLibraryView finds it
    // (issue tuxbooks-k5m).
    await ensureLibrary(page);
  }
});
