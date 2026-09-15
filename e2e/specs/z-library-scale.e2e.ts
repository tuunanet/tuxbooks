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

/** Grid window cap: PERF-15's budget, asserted live at scale. */
const WINDOW_CAP = 120;
/** Books pre-seeded into the scratch library by global setup. */
const SEEDED_BOOKS = 5;

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
    await expect(page.getByTestId("library-view")).toBeVisible({ timeout: 30000 });
  });

  test("imports 1,500 books and keeps the library interactive", async ({ page }) => {
    await test.setTimeout(240_000);

    // Bulk import through the real sidecar path with the UI live: the
    // report resolves when the run completes, while batched progress
    // events stream the books into the grid along the way.
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

    // The streamed events patched the grid live: the full count is in the
    // header (LibraryHeader shows visible.length, fed by the event
    // stream — no refetch involved).
    await expect(page.getByTestId("library-stats")).toHaveText(
      `${SEEDED_BOOKS + SCALE_CORPUS_SIZE} books`,
      { timeout: 30000 },
    );

    // PERF-15 at scale: right after the import (grid at top) only the
    // window is mounted, not 1,500 cards.
    expect(await cardCount(page)).toBeLessThanOrEqual(WINDOW_CAP);
    const beforeScroll = await firstCardTitle(page);

    // Scroll to the middle of the library: a different window renders —
    // instantly, no progressive loading — and it stays bounded.
    await page.evaluate(() => {
      const grid = document.querySelector<HTMLElement>('[data-testid="book-grid"]');
      if (grid) grid.scrollTop = grid.scrollHeight / 2;
    });
    await expect.poll(() => firstCardTitle(page)).not.toBe(beforeScroll);
    expect(await cardCount(page)).toBeLessThanOrEqual(WINDOW_CAP);

    // Sorting applies instantly across all 1,504 books: the card under
    // the (unchanged) scroll position changes.
    const beforeSort = await firstCardTitle(page);
    await page.getByRole("combobox", { name: "Sort books" }).click();
    await page.getByRole("option", { name: "Title" }).click();
    await expect.poll(() => firstCardTitle(page)).not.toBe(beforeSort);

    // Phase 2 contract at scale: a re-import is a stat-only pass — every
    // file unchanged, nothing re-parsed, reported as skipped.
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
