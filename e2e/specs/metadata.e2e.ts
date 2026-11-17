import { copyFileSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "../fixtures/electron-app.js";

import { epubFixture, seededBookTitles } from "../setup/fixtures.js";
import { libraryDir } from "../setup/environment.js";
import { ensureLibrary, openBookDetail, textOf, waitForLibraryView } from "./helpers.js";

/** The seeded EPUB file inside the scratch library (never the repo fixture). */
const seededEpub = path.join(libraryDir, "minimal.epub");
/** The one-time backup Save keeps next to the rewritten file. */
const seededEpubBackup = path.join(libraryDir, "minimal.epub.bak");

function sourceSnapshot(): { size: number; mtimeMs: number } {
  const stats = statSync(seededEpub);
  return { size: stats.size, mtimeMs: stats.mtimeMs };
}

/** DOM text of every library card, joined. */
async function cardTexts(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-testid=book-card]"))
      .map((card) => card.textContent ?? "")
      .join("\n"),
  );
}

/** Open the detail view's Metadata panel (issue #58: inline editing). */
async function openMetadataPanel(page: Page, ariaLabel: string): Promise<void> {
  await openBookDetail(page, ariaLabel);
  await page.getByTestId("detail-tab-metadata").click();
  await expect(page.getByTestId("metadata-panel")).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId("metadata-title")).not.toHaveValue("", { timeout: 30000 });
}

test.describe("metadata curation (milestone 7)", () => {
  // Each test rewrites the seeded EPUB; restore it so later specs keep the original bytes.
  test.afterEach(async ({ page }) => {
    if (!existsSync(seededEpubBackup)) return;
    copyFileSync(seededEpubBackup, seededEpub);
    rmSync(seededEpubBackup);
    await ensureLibrary(page);
    await expect
      .poll(() => cardTexts(page), {
        timeout: 30000,
        message: "the seeded EPUB title was not restored after the metadata edit",
      })
      .toContain(seededBookTitles.epub);
  });

  /**
   * One end-to-end save flow against the real binary: edit in the detail
   * panel → Save writes the fields the EPUB format supports into the file
   * behind a one-time `.bak` backup → the library and search reflect the new
   * values. The steps share one test because they build on the same book
   * state.
   */
  test("saves metadata into the file and reflects it across the library", async ({ page }) => {
    const before = sourceSnapshot();
    expect(existsSync(seededEpubBackup)).toBe(false);

    await openMetadataPanel(page, `${seededBookTitles.epub} (EPUB)`);

    await page.getByTestId("metadata-title").fill("The Curated Book");
    await page.getByTestId("metadata-authors").fill("Grace Hopper");
    await page.getByTestId("metadata-authors-add").click();
    await page.getByTestId("metadata-date").fill("1843");
    await page.getByTestId("metadata-series").fill("Analytical Engines");
    await page.getByTestId("metadata-series-index").fill("2");
    await page.getByTestId("metadata-panel-save").click();

    await expect(page.getByTestId("metadata-panel-saved")).toHaveText(
      "Saved. Written into the EPUB file.",
      { timeout: 30000 },
    );
    await expect(page.getByTestId("detail-title")).toContainText("The Curated Book", {
      timeout: 30000,
    });
    await expect(page.getByTestId("book-detail")).toContainText("Grace Hopper", {
      timeout: 30000,
    });

    await expect(page.getByTestId("metadata-panel-reset")).toBeDisabled();

    await page.getByTestId("detail-back").click();
    await waitForLibraryView(page);
    await expect.poll(() => cardTexts(page), { timeout: 30000 }).toContain("The Curated Book");

    const input = page.getByTestId("global-search");
    await input.click();
    await input.fill("curated");
    await expect(page.getByTestId("global-search-result")).toBeVisible({ timeout: 30000 });
    const hitText = await textOf(page, "global-search-result");
    expect(hitText).toContain("The Curated Book");
    await page.keyboard.press("Escape");

    // The rewrite leaves the original in the one-time `.bak` and embeds the title in the live file.
    const after = sourceSnapshot();
    expect(after.size).not.toBe(before.size);
    expect(after.mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs);
    expect(existsSync(seededEpubBackup)).toBe(true);
    expect(statSync(seededEpubBackup).size).toBe(readFileSync(epubFixture).length);
  });

  test("opens the metadata panel from a card's context menu", async ({ page }) => {
    await ensureLibrary(page);
    // Shared app state: the EPUB's title may be the source or a curated one from an earlier test.
    const card = page.locator('[aria-label*="(EPUB)"]');
    await card.waitFor({ state: "visible", timeout: 30000 });
    await card.click();
    await card.click({ button: "right" });

    const item = page.getByTestId("context-edit-metadata");
    await expect(item).toBeVisible({ timeout: 30000 });
    await item.click();

    await expect(page.getByTestId("metadata-panel")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("metadata-title")).not.toHaveValue("", { timeout: 30000 });
  });
});
