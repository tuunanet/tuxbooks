import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import { epubFixture, seededBookTitles } from "../setup/fixtures.js";
import { libraryDir } from "../setup/environment.js";
import { ensureLibrary, openBookDetail, textOf, waitForLibraryView } from "./helpers.js";

/** The seeded EPUB file inside the scratch library (never the repo fixture). */
const seededEpub = path.join(libraryDir, "minimal.epub");

function sourceSnapshot(): { size: number; mtimeMs: number } {
  const stats = statSync(seededEpub);
  return { size: stats.size, mtimeMs: stats.mtimeMs };
}

/** DOM text of every library card, joined (getText misses line-clamped titles). */
async function cardTexts(): Promise<string> {
  const texts = await browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-testid=book-card]")).map(
      (card) => card.textContent ?? "",
    ),
  );
  return texts.join("\n");
}

describe("metadata curation (milestone 7)", () => {
  /**
   * One end-to-end curation flow against the real binary: edit → library
   * and search reflect it → the source file is untouched → reset restores
   * the file metadata. The steps share one test because they build on the
   * same book state.
   */
  it("edits metadata, keeps the source file untouched, and resets", async () => {
    const before = sourceSnapshot();

    await openBookDetail(`${seededBookTitles.epub} (EPUB)`);

    // The detail view opens the editor; the form arrives prefilled.
    await $("[data-testid=detail-edit]").click();
    const dialog = await $("[data-testid=metadata-dialog]");
    await dialog.waitForDisplayed({ timeout: 30000 });
    const titleInput = await $("[data-testid=metadata-title]");
    await browser.waitUntil(async () => (await titleInput.getValue()) !== "", {
      timeout: 30000,
      timeoutMsg: "metadata form never arrived",
    });
    expect(await titleInput.getValue()).toBe(seededBookTitles.epub);
    expect(await $("[data-testid=metadata-authors]").getValue()).toBe("Ada Lovelace");

    // Edit title + author; add a series and publication date. The form was
    // prefilled, so untouched fields round-trip unchanged.
    await titleInput.setValue("The Curated Book");
    const authors = await $("[data-testid=metadata-authors]");
    await authors.setValue("Ada Lovelace, Grace Hopper");
    await $("[data-testid=metadata-date]").setValue("1843");
    await $("[data-testid=metadata-series]").setValue("Analytical Engines");
    await $("[data-testid=metadata-series-index]").setValue("2");
    await $("[data-testid=metadata-save]").click();
    await dialog.waitForDisplayed({ reverse: true, timeout: 30000 });

    // The detail view refreshed through the library-changed event.
    await browser.waitUntil(
      async () => (await textOf("detail-title")).includes("The Curated Book"),
      { timeout: 30000, timeoutMsg: "detail title never showed the edit" },
    );
    const facts = await textOf("detail-facts");
    expect(facts).toContain("1843");
    expect(facts).toContain("Analytical Engines #2");
    // The author line carries the multi-author display projection.
    await browser.waitUntil(async () => (await textOf("book-detail")).includes("Grace Hopper"), {
      timeout: 30000,
      timeoutMsg: "detail author list never updated",
    });

    // The library grid shows the new title on the same card.
    await $("[data-testid=detail-back]").click();
    await waitForLibraryView();
    await browser.waitUntil(async () => (await cardTexts()).includes("The Curated Book"), {
      timeout: 30000,
      timeoutMsg: "library grid never showed the edited title",
    });

    // FTS picked up the edit: the new title is the ranked hit.
    const input = await $("[data-testid=global-search]");
    await input.click();
    await input.setValue("curated");
    await $("[data-testid=global-search-result]").waitForDisplayed({ timeout: 30000 });
    const hitText = await browser.execute(
      () => document.querySelector("[data-testid=global-search-result]")?.textContent ?? "",
    );
    expect(hitText).toContain("The Curated Book");
    await browser.keys("Escape");

    // The source file was never rewritten (curation is database-only).
    const after = sourceSnapshot();
    expect(after.size).toBe(readFileSync(epubFixture).length);
    expect(after.mtimeMs).toBe(before.mtimeMs);

    // Reset to source: the editor repopulates from the file metadata and
    // the reset restores the original title everywhere.
    await openBookDetail("The Curated Book (EPUB)");
    await $("[data-testid=detail-edit]").click();
    const resetDialog = await $("[data-testid=metadata-dialog]");
    await resetDialog.waitForDisplayed({ timeout: 30000 });
    await $("[data-testid=metadata-reset]").click();
    await browser.waitUntil(
      async () => (await $("[data-testid=metadata-title]").getValue()) === seededBookTitles.epub,
      { timeout: 30000, timeoutMsg: "reset never restored the source title" },
    );
    await $("[data-testid=metadata-cancel]").click();
    await resetDialog.waitForDisplayed({ reverse: true, timeout: 30000 });
    await browser.waitUntil(
      async () => (await textOf("detail-title")).includes(seededBookTitles.epub),
      { timeout: 30000, timeoutMsg: "detail title never returned to the source" },
    );

    // The FTS round trip completes: the curated title is gone again.
    await $("[data-testid=detail-back]").click();
    await waitForLibraryView();
    const searchInput = await $("[data-testid=global-search]");
    await searchInput.click();
    await searchInput.setValue("curated");
    await $("[data-testid=global-search-empty]").waitForDisplayed({ timeout: 30000 });
    await browser.keys("Escape");
  });

  it("opens the metadata editor from a card's context menu", async () => {
    await ensureLibrary();
    // The seeded library has exactly one EPUB; its title may be the source
    // title or a curated one depending on the first test's outcome.
    const card = await $('[aria-label*="(EPUB)"]');
    await card.waitForDisplayed({ timeout: 30000 });
    await card.click();
    await card.click({ button: "right" });

    const item = await $("[data-testid=context-edit-metadata]");
    await item.waitForDisplayed({ timeout: 30000 });
    await item.click();

    const dialog = await $("[data-testid=metadata-dialog]");
    await dialog.waitForDisplayed({ timeout: 30000 });
    await $("[data-testid=metadata-cancel]").click();
    await dialog.waitForDisplayed({ reverse: true, timeout: 30000 });
  });
});
