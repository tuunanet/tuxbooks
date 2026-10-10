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
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "../fixtures/electron-app.js";

import { epubFixture, seededLibraryBookCount } from "../setup/fixtures.js";
import { libraryDir, scratchDir } from "../setup/environment.js";

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
    expect(await cardCount(page)).toBe(seededLibraryBookCount);

    copyFileSync(epubFixture, path.join(libraryDir, "sync-added.epub"));

    await expect
      .poll(() => cardCount(page), {
        timeout: 30000,
        message: "a book added on disk never appeared in the library",
      })
      .toBe(seededLibraryBookCount + 1);
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
      .toEqual({ count: seededLibraryBookCount + 1, missing: 0 });
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
      .toEqual({ count: seededLibraryBookCount + 1, missing: 1 });
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
      .toBe(seededLibraryBookCount);
    expect(await missingOverlays(page)).toBe(0);
  });

  test("importing a single file watches its folder so siblings arrive alone", async ({ page }) => {
    // A shelf outside the seeded library, so the mirror round trip never
    // disturbs the fixtures the other suites run against.
    const shelf = path.join(scratchDir, "single-file-shelf");
    mkdirSync(shelf, { recursive: true });
    const first = path.join(shelf, "single-first.epub");
    copyFileSync(epubFixture, first);

    // The native file dialog cannot be driven from the automation surface,
    // so the file comes in through the same bridge command Import Files
    // issues (same rule as the unwatch scenario below).
    const report = (await page.evaluate(
      (file) => window.tuxbooks!.invoke("import_paths", { paths: [file] }),
      first,
    )) as { imported: number; failed: unknown[]; watched: string[] };
    expect(report.failed).toEqual([]);
    expect(report.watched).toEqual([shelf]);
    await expect
      .poll(() => cardCount(page), {
        timeout: 30000,
        message: "the imported shelf book never appeared in the library",
      })
      .toBe(seededLibraryBookCount + 1);

    // Watching never happens silently: the shelf is listed where the user
    // manages watches — Settings > Folders.
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByTestId("settings-view")).toBeVisible();
    await page.getByRole("button", { name: "Folders" }).click();
    const list = page.getByTestId("folders-list");
    await expect(list.locator("li", { hasText: shelf })).toBeVisible();
    await page.getByRole("button", { name: "All Books" }).click();
    await expect(page.getByTestId("library-view")).toBeVisible();

    // A sibling dropped on disk afterwards appears without a second import.
    copyFileSync(epubFixture, path.join(shelf, "single-second.epub"));
    await expect
      .poll(() => cardCount(page), {
        timeout: 30000,
        message: "a sibling dropped into the newly watched folder never appeared",
      })
      .toBe(seededLibraryBookCount + 2);

    // Clean up the way a user would: unwatch purges the shelf's books and
    // stops the watch; the files on disk stay for the rm below.
    await page.evaluate(
      (dir) => window.tuxbooks!.invoke("unwatch_locations", { paths: [dir] }),
      shelf,
    );
    await expect
      .poll(() => cardCount(page), {
        timeout: 30000,
        message: "the unwatched shelf's books never left the library",
      })
      .toBe(seededLibraryBookCount);
    rmSync(shelf, { recursive: true, force: true });
  });

  test("unwatching a folder empties the app of its books while files stay", async ({ page }) => {
    // A shelf outside the seeded library, so the mirror round trip never
    // disturbs the fixtures the other suites run against.
    const shelf = path.join(scratchDir, "unwatch-shelf");
    const shelfBook = path.join(shelf, "shelf-book.epub");
    mkdirSync(shelf, { recursive: true });
    copyFileSync(epubFixture, shelfBook);
    const before = readFileSync(shelfBook);

    // The native import dialog cannot be driven from the automation surface,
    // so the shelf comes in through the same bridge command the UI's Import
    // Folder flow issues (same rule as the scale spec).
    const report = (await page.evaluate(
      (dir) => window.tuxbooks!.invoke("import_paths", { paths: [dir] }),
      shelf,
    )) as { imported: number; failed: unknown[] };
    expect(report).toMatchObject({ imported: 1, failed: [] });
    await expect
      .poll(() => cardCount(page), {
        timeout: 30000,
        message: "the imported shelf book never appeared in the library",
      })
      .toBe(seededLibraryBookCount + 1);

    // Unwatch it the way a user does: Settings > Folders > select > Unwatch.
    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByTestId("settings-view")).toBeVisible();
    await page.getByRole("button", { name: "Folders" }).click();
    const list = page.getByTestId("folders-list");
    const row = list.locator("li", { hasText: shelf });
    await expect(row).toBeVisible();
    await row.getByRole("checkbox", { name: `Select ${shelf}` }).click();
    await page.getByTestId("folders-unwatch").click();

    // Destructive-only: no keep/remove choice, the loss is spelled out, and
    // the files-on-disk promise stands.
    const dialog = page.getByTestId("unwatch-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("unwatch-remove-books")).toHaveCount(0);
    await expect(dialog).toContainText(
      "The 1 book in this folder is removed from your library, along with its reading progress and annotations.",
    );
    await expect(dialog).toContainText("Your files on disk stay untouched.");
    await page.getByTestId("unwatch-confirm").click();

    // The shelf leaves the watch list...
    await expect(row).toHaveCount(0);

    // ...its book leaves the library view...
    await page.getByRole("button", { name: "All Books" }).click();
    await expect(page.getByTestId("library-view")).toBeVisible();
    await expect
      .poll(() => cardCount(page), {
        timeout: 30000,
        message: "the unwatched folder's book never left the library",
      })
      .toBe(seededLibraryBookCount);

    // ...and the file on disk is byte-for-byte what it was.
    expect(readFileSync(shelfBook).equals(before)).toBe(true);
    rmSync(shelf, { recursive: true, force: true });
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
    expect(allText).toContain("Smart Colors");
    expect(await missingOverlays(page)).toBe(0);
  });
});
