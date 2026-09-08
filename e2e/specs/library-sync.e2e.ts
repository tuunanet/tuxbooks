/**
 * Filesystem synchronization E2E (ROADMAP milestone 3). Runs against the
 * real app watching the seeded library directory: books added, renamed, and
 * deleted on disk appear, move, and become unavailable in the UI without
 * any manual rescan.
 *
 * Every scenario works on copies of the fixture EPUB (never the seeded
 * files) so the reader suites stay independent of this spec's file churn.
 * The native "Locate File" dialog is deliberately not driven here —
 * native dialogs cannot be operated from the renderer automation surface —
 * reconnection is covered by frontend and Rust tests instead.
 */
import { renameSync, copyFileSync, rmSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "../fixtures/electron-app.js";

import { epubFixture } from "../setup/fixtures.js";
import { libraryDir } from "../setup/environment.js";

async function cardCount(page: Page): Promise<number> {
  return page.getByTestId("book-card").count();
}

async function missingOverlays(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-testid="book-card-missing"]').length);
}

test.describe("tuxbooks filesystem synchronization", () => {
  test.beforeEach(async ({ page }) => {
    await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("library-view")).toBeVisible({ timeout: 30000 });
  });

  test("imports a book dropped into the watched library while the app runs", async ({ page }) => {
    expect(await cardCount(page)).toBe(4);

    copyFileSync(epubFixture, path.join(libraryDir, "sync-added.epub"));

    await expect
      .poll(() => cardCount(page), {
        timeout: 30000,
        message: "a book added on disk never appeared in the library",
      })
      .toBe(5);
  });

  test("keeps the book available when its file is renamed on disk", async ({ page }) => {
    renameSync(path.join(libraryDir, "sync-added.epub"), path.join(libraryDir, "sync-moved.epub"));

    // The book survives the move: no duplicate row, no missing marker.
    await expect
      .poll(
        async () => ({
          count: await cardCount(page),
          missing: await missingOverlays(page),
        }),
        { timeout: 30000, message: "renaming a file on disk broke its library entry" },
      )
      .toEqual({ count: 5, missing: 0 });
  });

  test("marks the book unavailable when its file disappears", async ({ page }) => {
    rmSync(path.join(libraryDir, "sync-moved.epub"));

    // The row is kept (progress/metadata survive reconnection), shown as
    // missing instead of being silently dropped.
    await expect
      .poll(
        async () => ({
          count: await cardCount(page),
          missing: await missingOverlays(page),
        }),
        {
          timeout: 30000,
          message: "a deleted file neither stayed available nor turned up missing",
        },
      )
      .toEqual({ count: 5, missing: 1 });
  });

  test("removes the missing book from the library on demand", async ({ page }) => {
    const removeButton = page.getByTestId("missing-remove");
    await expect(removeButton).toBeVisible({ timeout: 30000 });
    await removeButton.click();

    await expect
      .poll(() => cardCount(page), {
        timeout: 30000,
        message: "the removed book never left the library view",
      })
      .toBe(4);
    expect(await missingOverlays(page)).toBe(0);
  });

  test("leaves the seeded library intact for the other suites", async ({ page }) => {
    const allText = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid=book-card]"))
        .map((card) => card.textContent ?? "")
        .join("\n"),
    );
    expect(allText).toContain("A Minimal Book");
    expect(allText).toContain("A Minimal Manual");
    expect(allText).toContain("A Large Fixture");
    expect(allText).toContain("Odd Sizes");
    expect(await missingOverlays(page)).toBe(0);
  });
});
