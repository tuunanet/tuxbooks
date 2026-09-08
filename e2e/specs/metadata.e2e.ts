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

test.describe("metadata curation (milestone 7)", () => {
  /**
   * One end-to-end curation flow against the real binary: edit → library
   * and search reflect it → the source file is untouched → reset restores
   * the file metadata. The steps share one test because they build on the
   * same book state.
   */
  test("edits metadata, keeps the source file untouched, and resets", async ({ page }) => {
    const before = sourceSnapshot();

    await openBookDetail(page, `${seededBookTitles.epub} (EPUB)`);

    // The detail view opens the editor; the form arrives prefilled.
    await page.getByTestId("detail-edit").click();
    const dialog = page.getByTestId("metadata-dialog");
    await expect(dialog).toBeVisible({ timeout: 30000 });
    const titleInput = page.getByTestId("metadata-title");
    await expect(titleInput).not.toHaveValue("", { timeout: 30000 });
    expect(await titleInput.inputValue()).toBe(seededBookTitles.epub);
    await expect(page.getByTestId("metadata-authors")).toHaveValue("Ada Lovelace");

    // Edit title + author; add a series and publication date. The form was
    // prefilled, so untouched fields round-trip unchanged.
    await titleInput.fill("The Curated Book");
    await page.getByTestId("metadata-authors").fill("Ada Lovelace, Grace Hopper");
    await page.getByTestId("metadata-date").fill("1843");
    await page.getByTestId("metadata-series").fill("Analytical Engines");
    await page.getByTestId("metadata-series-index").fill("2");
    await page.getByTestId("metadata-save").click();
    await dialog.waitFor({ state: "detached", timeout: 30000 });

    // The detail view refreshed through the library-changed event.
    await expect(page.getByTestId("detail-title")).toContainText("The Curated Book", {
      timeout: 30000,
    });
    const facts = await textOf(page, "detail-facts");
    expect(facts).toContain("1843");
    expect(facts).toContain("Analytical Engines #2");
    // The author line carries the multi-author display projection.
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
    const hitText = await page.evaluate(
      () => document.querySelector("[data-testid=global-search-result]")?.textContent ?? "",
    );
    expect(hitText).toContain("The Curated Book");
    await page.keyboard.press("Escape");

    // The source file was never rewritten (curation is database-only).
    const after = sourceSnapshot();
    expect(after.size).toBe(readFileSync(epubFixture).length);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    // Reset to source: the editor repopulates from the file metadata and
    // the reset restores the original title everywhere.
    await openBookDetail(page, "The Curated Book (EPUB)");
    await page.getByTestId("detail-edit").click();
    const resetDialog = page.getByTestId("metadata-dialog");
    await expect(resetDialog).toBeVisible({ timeout: 30000 });
    await page.getByTestId("metadata-reset").click();
    await expect(page.getByTestId("metadata-title")).toHaveValue(seededBookTitles.epub, {
      timeout: 30000,
    });
    await page.getByTestId("metadata-cancel").click();
    await resetDialog.waitFor({ state: "detached", timeout: 30000 });
    await expect(page.getByTestId("detail-title")).toContainText(seededBookTitles.epub, {
      timeout: 30000,
    });

    // The FTS round trip completes: the curated title is gone again.
    await page.getByTestId("detail-back").click();
    await waitForLibraryView(page);
    const searchInput = page.getByTestId("global-search");
    await searchInput.click();
    await searchInput.fill("curated");
    await expect(page.getByTestId("global-search-empty")).toBeVisible({ timeout: 30000 });
    await page.keyboard.press("Escape");
  });

  test("opens the metadata editor from a card's context menu", async ({ page }) => {
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

    const dialog = page.getByTestId("metadata-dialog");
    await expect(dialog).toBeVisible({ timeout: 30000 });
    await page.getByTestId("metadata-cancel").click();
    await dialog.waitFor({ state: "detached", timeout: 30000 });
  });
});
