import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "../fixtures/electron-app.js";

import { epubFixture, seededBookTitles } from "../setup/fixtures.js";
import { libraryDir } from "../setup/environment.js";
import { ensureLibrary, openBookDetail, textOf, waitForLibraryView } from "./helpers.js";

/** The seeded EPUB file inside the scratch library (never the repo fixture). */
const seededEpub = path.join(libraryDir, "minimal.epub");

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
  // The sidecar file-properties read must be reachable (allowlist guard).
  await expect(page.getByTestId("file-properties-list")).toBeVisible({ timeout: 30000 });
}

test.describe("metadata curation (milestone 7)", () => {
  /**
   * One end-to-end curation flow against the real binary: edit in the detail
   * panel → library and search reflect it → the source file is untouched →
   * reset restores the file metadata. The steps share one test because they
   * build on the same book state.
   */
  test("edits metadata, keeps the source file untouched, and resets", async ({ page }) => {
    const before = sourceSnapshot();

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

    // Save confirmation, then the hero reflects the edit through library-changed.
    await expect(page.getByTestId("metadata-panel-saved")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("detail-title")).toContainText("The Curated Book", {
      timeout: 30000,
    });
    await expect(page.getByTestId("book-detail")).toContainText("Grace Hopper", {
      timeout: 30000,
    });

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

    // The source file was never rewritten (curation is database-only).
    const after = sourceSnapshot();
    expect(after.size).toBe(readFileSync(epubFixture).length);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    // Reset to source: the form repopulates from the file metadata and the
    // original title returns everywhere.
    await openMetadataPanel(page, "The Curated Book (EPUB)");
    await page.getByTestId("metadata-panel-reset").click();
    await expect(page.getByTestId("metadata-title")).toHaveValue(seededBookTitles.epub, {
      timeout: 30000,
    });

    await page.getByTestId("detail-back").click();
    await waitForLibraryView(page);
    const searchInput = page.getByTestId("global-search");
    await searchInput.click();
    await searchInput.fill("curated");
    await expect(page.getByTestId("global-search-empty")).toBeVisible({ timeout: 30000 });
    await page.keyboard.press("Escape");
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
