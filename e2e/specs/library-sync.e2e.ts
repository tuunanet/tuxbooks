/**
 * Filesystem synchronization E2E (ROADMAP milestone 3). Runs against the
 * real Tauri binary watching the seeded library directory: books added,
 * renamed, and deleted on disk appear, move, and become unavailable in the
 * UI without any manual rescan.
 *
 * Every scenario works on copies of the fixture EPUB (never the seeded
 * files) so the reader suites stay independent of this spec's file churn.
 * The native "Locate File" dialog is deliberately not driven here —
 * WebKitWebDriver cannot operate GTK dialogs — reconnection is covered by
 * frontend and Rust tests instead.
 */
import { renameSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { epubFixture } from "../setup/fixtures.js";

const libraryDir = process.env.TEST_LIBRARY_PATH ?? "";

async function cardCount(): Promise<number> {
  return (await $$("[data-testid=book-card]")).length;
}

async function missingOverlays(): Promise<number> {
  return browser.execute(
    () => document.querySelectorAll('[data-testid="book-card-missing"]').length,
  );
}

describe("tuxbooks filesystem synchronization", () => {
  before(async () => {
    await $("[data-testid=app-shell]").waitForDisplayed({ timeout: 30000 });
    await $("[data-testid=library-view]").waitForDisplayed({ timeout: 30000 });
  });

  it("imports a book dropped into the watched library while the app runs", async () => {
    expect(await cardCount()).toBe(4);

    copyFileSync(epubFixture, path.join(libraryDir, "sync-added.epub"));

    await browser.waitUntil(async () => (await cardCount()) === 5, {
      timeout: 30000,
      timeoutMsg: "a book added on disk never appeared in the library",
    });
  });

  it("keeps the book available when its file is renamed on disk", async () => {
    renameSync(path.join(libraryDir, "sync-added.epub"), path.join(libraryDir, "sync-moved.epub"));

    // The book survives the move: no duplicate row, no missing marker.
    await browser.waitUntil(
      async () => {
        const count = await cardCount();
        const missing = await missingOverlays();
        return count === 5 && missing === 0;
      },
      { timeout: 30000, timeoutMsg: "renaming a file on disk broke its library entry" },
    );
  });

  it("marks the book unavailable when its file disappears", async () => {
    rmSync(path.join(libraryDir, "sync-moved.epub"));

    // The row is kept (progress/metadata survive reconnection), shown as
    // missing instead of being silently dropped.
    await browser.waitUntil(
      async () => {
        const count = await cardCount();
        const missing = await missingOverlays();
        return count === 5 && missing === 1;
      },
      {
        timeout: 30000,
        timeoutMsg: "a deleted file neither stayed available nor turned up missing",
      },
    );
  });

  it("removes the missing book from the library on demand", async () => {
    const removeButton = await $("[data-testid=missing-remove]");
    await removeButton.waitForDisplayed({ timeout: 30000 });
    await removeButton.click();

    await browser.waitUntil(async () => (await cardCount()) === 4, {
      timeout: 30000,
      timeoutMsg: "the removed book never left the library view",
    });
    expect(await missingOverlays()).toBe(0);
  });

  it("leaves the seeded library intact for the other suites", async () => {
    const cardTexts = await browser.execute(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid=book-card]")).map(
        (card) => card.textContent ?? "",
      ),
    );
    const allText = cardTexts.join("\n");
    expect(allText).toContain("A Minimal Book");
    expect(allText).toContain("A Minimal Manual");
    expect(allText).toContain("A Large Fixture");
    expect(allText).toContain("Odd Sizes");
    expect(await missingOverlays()).toBe(0);
  });
});
