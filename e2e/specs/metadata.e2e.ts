import { existsSync, readFileSync, statSync } from "node:fs";
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

    // Edit title + add a second author + series and publication date. The form
    // was prefilled, so untouched fields round-trip unchanged.
    await page.getByTestId("metadata-title").fill("The Curated Book");
    await page.getByTestId("metadata-authors").fill("Grace Hopper");
    await page.getByTestId("metadata-authors-add").click();
    await page.getByTestId("metadata-date").fill("1843");
    await page.getByTestId("metadata-series").fill("Analytical Engines");
    await page.getByTestId("metadata-series-index").fill("2");
    await page.getByTestId("metadata-panel-save").click();

    // Save confirmation: every field fits an EPUB, so nothing stays behind
    // as a library edit. The hero reflects the edit through library-changed.
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

    // With no remaining overrides the reset affordance retires itself.
    await expect(page.getByTestId("metadata-panel-reset")).toBeDisabled();

    // The library grid shows the new title on the same card.
    await page.getByTestId("detail-back").click();
    await waitForLibraryView(page);
    await expect.poll(() => cardTexts(page), { timeout: 30000 }).toContain("The Curated Book");

    // FTS picked up the edit: the new title is the ranked hit.
    const input = page.getByTestId("global-search");
    await input.click();
    await input.fill("curated");
    await expect(page.getByTestId("global-search-result")).toBeVisible({ timeout: 30000 });
    const hitText = await textOf(page, "global-search-result");
    expect(hitText).toContain("The Curated Book");
    await page.keyboard.press("Escape");

    // The file itself was rewritten: the original rides in the one-time
    // `.bak`, and the live file now carries the embedded title.
    const after = sourceSnapshot();
    expect(after.size).not.toBe(before.size);
    expect(after.mtimeMs).toBeGreaterThanOrEqual(before.mtimeMs);
    expect(existsSync(seededEpubBackup)).toBe(true);
    expect(statSync(seededEpubBackup).size).toBe(readFileSync(epubFixture).length);
  });

  test("opens the metadata panel from a card's context menu", async ({ page }) => {
    await ensureLibrary(page);
    // The seeded library has exactly one EPUB; its title may be the source
    // title or a curated one depending on the first test's outcome.
    const card = page.locator('[aria-label*="(EPUB)"]');
    await card.waitFor({ state: "visible", timeout: 30000 });
    await card.click();
    await card.click({ button: "right" });

    const item = page.getByTestId("context-edit-metadata");
    await expect(item).toBeVisible({ timeout: 30000 });
    await item.click();

    // The action now lands on the detail view's Metadata panel.
    await expect(page.getByTestId("metadata-panel")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("metadata-title")).not.toHaveValue("", { timeout: 30000 });
  });
});
