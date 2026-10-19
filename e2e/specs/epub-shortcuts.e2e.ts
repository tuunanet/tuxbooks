/**
 * Keyboard shortcuts while focus is inside the EPUB content frame. The
 * shortcut provider listens on the app window; keydown in the frame never
 * reaches it, so the engine must forward the reader's combos. Regression:
 * the highlights shortcut (and panel shortcuts generally) died as soon as a
 * click landed in the text, which readers do right after highlighting.
 */
import { expect, test, type Page } from "../fixtures/electron-app.js";
import { closeReaderNavigation, openInReader } from "./helpers.js";

async function paragraphLine(page: Page): Promise<{ x1: number; y: number; x2: number } | null> {
  return page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>("iframe.readium-navigator-iframe");
    const doc = frame?.contentDocument;
    if (!frame || !doc) return null;
    const paragraph = Array.from(doc.querySelectorAll("p")).find((candidate) =>
      (candidate.textContent ?? "").includes("first chapter"),
    );
    const node = paragraph?.firstChild;
    if (!node) return null;
    const range = doc.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min((node.textContent ?? "").length, 24));
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
    const first = rects[0];
    const last = rects[rects.length - 1];
    if (!first || !last) return null;
    const frameRect = frame.getBoundingClientRect();
    return {
      x1: frameRect.x + first.x + 1,
      x2: frameRect.x + last.x + last.width - 1,
      y: frameRect.y + first.y + first.height / 2,
    };
  });
}

async function pressShortcutAndCheck(page: Page): Promise<boolean> {
  await page.keyboard.press("Control+Shift+H");
  return page
    .getByTestId("reader-nav")
    .waitFor({ state: "visible", timeout: 2500 })
    .then(() => true)
    .catch(() => false);
}

test("panel shortcuts work with focus inside the EPUB content frame", async ({ page }) => {
  await openInReader(page, "A Minimal Book (EPUB)");
  await expect(page.getByTestId("reader-view")).toBeVisible({ timeout: 30000 });

  const line = await expect
    .poll(async () => (await paragraphLine(page)) !== null, { timeout: 30000 })
    .toBe(true)
    .then(() => paragraphLine(page));
  expect(line).not.toBeNull();

  // Click into the text: focus enters the content frame.
  await page.mouse.click(line!.x1 + 20, line!.y);
  await page.waitForTimeout(200);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document
            .querySelector<HTMLIFrameElement>("iframe.readium-navigator-iframe")
            ?.contentDocument?.hasFocus() ?? false,
      ),
    )
    .toBe(true);
  expect(await pressShortcutAndCheck(page)).toBe(true);
  await page.keyboard.press("Control+Shift+H");
  await expect(page.getByTestId("reader-nav")).toBeHidden({ timeout: 5000 });
  await page.waitForTimeout(500); // let the drawer's exit animation release the pointer

  // Same after creating a highlight (the reported flow).
  await page.mouse.move(line!.x1, line!.y);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) {
    const t = step / 10;
    await page.mouse.move(line!.x1 + (line!.x2 - line!.x1) * t, line!.y);
  }
  await page.mouse.up();
  await expect(page.getByTestId("selection-toolbar")).toBeVisible({ timeout: 10000 });
  await page.getByTestId("highlight-color-yellow").click();
  await page.waitForTimeout(800);

  await page.mouse.click(line!.x1 + 20, line!.y);
  await page.waitForTimeout(200);
  expect(await pressShortcutAndCheck(page)).toBe(true);
  await closeReaderNavigation(page);
});
