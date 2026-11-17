/**
 * Library scale E2E (issue #61, phase 3): imports a 1,500-book generated
 * corpus through the real `import_paths` bulk path while the UI is live,
 * then asserts the phase-1 contracts at scale — the grid stays a bounded
 * window while scrolling, books stream in live, sorting applies instantly
 * across the whole library, and a re-import is a stat-only skip pass
 * (phase 2). Structural assertions only; timing budgets stay in
 * `docs/PERFORMANCE.md` and are never asserted here.
 *
 * The import is driven through the renderer's own bridge (`page.evaluate`
 * → `window.tuxbooks.invoke`): the native folder dialog cannot be operated
 * from the automation surface (same rule as library-sync's "Locate File"
 * note), and this exercises the exact command the UI's Import Folder flow
 * issues, with progress events landing in the live grid.
 *
 * The file name is deliberately last in sort order: the phase shares one
 * app and library ("file order matters" in playwright.config), and this
 * spec leaves 1,500 extra books behind — every other suite assumes the
 * seeded fixtures, so the corpus runs after all of them.
 */
import { readdirSync } from "node:fs";

import { expect, test, type Page } from "../fixtures/electron-app.js";

import { SCALE_CORPUS_SIZE, scaleCorpusDir } from "../setup/environment.js";
import { seededLibraryBookCount } from "../setup/fixtures.js";
import { ensureLibrary } from "./helpers.js";

/** Grid window cap: PERF-15's budget, asserted live at scale. */
const WINDOW_CAP = 120;

function corpusReady(): boolean {
  try {
    return readdirSync(scaleCorpusDir).length >= SCALE_CORPUS_SIZE;
  } catch {
    return false;
  }
}

async function cardCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-testid="book-card"]').length);
}

async function firstCardTitle(page: Page): Promise<string> {
  return page.evaluate(
    () => document.querySelector('[data-testid="book-card"]')?.getAttribute("aria-label") ?? "",
  );
}

test.describe("library scale (issue #61)", () => {
  test.skip(!corpusReady(), "scale corpus not generated (python3 missing or generation failed)");

  test.beforeEach(async ({ page }) => {
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30000 });
    await ensureLibrary(page);
  });

  test("imports 1,500 books and keeps the library interactive", async ({ page }) => {
    await test.setTimeout(240_000);

    const report = (await page.evaluate(
      (dir) =>
        (
          window as unknown as {
            tuxbooks: { invoke(method: string, params: unknown): Promise<unknown> };
          }
        ).tuxbooks.invoke("import_paths", { paths: [dir] }),
      scaleCorpusDir,
    )) as Record<string, number>;
    expect(report).toMatchObject({ imported: SCALE_CORPUS_SIZE, skipped: 0 });

    await expect(page.getByTestId("library-stats")).toHaveText(
      `${seededLibraryBookCount + SCALE_CORPUS_SIZE} books`,
      { timeout: 30000 },
    );

    // PERF-15 at scale: only the window is mounted, not 1,500 cards.
    expect(await cardCount(page)).toBeLessThanOrEqual(WINDOW_CAP);
    const beforeScroll = await firstCardTitle(page);

    await page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>('[data-testid="book-grid"]');
      if (grid) grid.scrollTop = grid.scrollHeight / 2;
    });
    await expect.poll(() => firstCardTitle(page)).not.toBe(beforeScroll);
    expect(await cardCount(page)).toBeLessThanOrEqual(WINDOW_CAP);

    const beforeSort = await firstCardTitle(page);
    await page.getByRole("combobox", { name: "Sort books" }).click();
    await page.getByRole("option", { name: "Title" }).click();
    await expect.poll(() => firstCardTitle(page)).not.toBe(beforeSort);

    // Phase 2: a re-import is stat-only; unchanged files are skipped, not re-parsed.
    const second = (await page.evaluate(
      (dir) =>
        (
          window as unknown as {
            tuxbooks: { invoke(method: string, params: unknown): Promise<unknown> };
          }
        ).tuxbooks.invoke("import_paths", { paths: [dir] }),
      scaleCorpusDir,
    )) as Record<string, number>;
    expect(second).toMatchObject({
      imported: 0,
      updated: 0,
      skipped: SCALE_CORPUS_SIZE,
    });
  });
});
