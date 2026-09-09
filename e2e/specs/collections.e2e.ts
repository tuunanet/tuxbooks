import { expect, test } from "../fixtures/electron-app.js";

import { seededBookTitles } from "../setup/fixtures.js";
import { ensureLibrary, waitForLibraryView } from "./helpers.js";

/**
 * Library curation surfaces (milestone 10) against the real binary: one
 * flow that creates a collection, files a book into it through the card
 * context menu, removes it again, marks a book finished, and deletes the
 * collection. The steps share one test because they build on the same
 * collection state.
 */
test.describe("collections and reading sections (milestone 10)", () => {
  test("creates a collection, manages membership, marks finished, and cleans up", async ({
    page,
  }) => {
    await ensureLibrary(page);

    // Create the collection from the sidebar; creation lands in its section.
    await page.getByTestId("new-collection-button").click();
    const dialog = page.getByTestId("collection-dialog");
    await expect(dialog).toBeVisible({ timeout: 30000 });
    await page.getByTestId("collection-name").fill("Reading Queue");
    await page.getByTestId("collection-create").click();
    await dialog.waitFor({ state: "detached", timeout: 30000 });
    await expect(page.getByRole("heading", { name: "Reading Queue" })).toBeVisible({
      timeout: 30000,
    });
    // The fresh collection is empty.
    await expect(page.getByTestId("empty-collection")).toBeVisible({ timeout: 30000 });

    // Add the seeded EPUB through the card's context menu.
    await page.getByRole("button", { name: "All Books" }).click();
    await waitForLibraryView(page);
    const card = page.locator(`[aria-label^="${seededBookTitles.epub}"]`);
    await card.waitFor({ state: "visible", timeout: 30000 });
    await card.click();
    await card.click({ button: "right" });
    await expect(page.getByTestId("context-add-to-collection")).toBeVisible({ timeout: 30000 });
    await page.getByTestId("context-add-to-collection").click();
    const addEntry = page.locator("[data-testid^=context-add-to-collection-]");
    await expect(addEntry).toBeVisible({ timeout: 30000 });
    await addEntry.click();
    // The menu closes after the selection.
    await page
      .getByTestId("context-add-to-collection")
      .waitFor({ state: "detached", timeout: 30000 });

    // The collection section lists exactly the member book.
    // The name matches both the sidebar nav item and the section header
    // control — the sidebar nav item is the first match (WDIO semantics).
    await page.getByRole("button", { name: "Reading Queue" }).first().click();
    await waitForLibraryView(page);
    await expect(page.getByTestId("book-card").first()).toBeVisible({ timeout: 30000 });
    const memberCards = await page.getByTestId("book-card").all();
    expect(memberCards).toHaveLength(1);
    const memberText = await page.evaluate(
      () => document.querySelector("[data-testid=book-card]")?.textContent ?? "",
    );
    expect(memberText).toContain(seededBookTitles.epub);

    // Remove the membership again from the same context menu.
    const memberCard = page.getByTestId("book-card");
    await memberCard.click();
    await memberCard.click({ button: "right" });
    await expect(page.getByTestId("context-remove-from-collection")).toBeVisible({
      timeout: 30000,
    });
    await page.getByTestId("context-remove-from-collection").click();
    const removeEntry = page.locator("[data-testid^=context-remove-from-collection-]");
    await expect(removeEntry).toBeVisible({ timeout: 30000 });
    await removeEntry.click();
    // The section empties out live.
    await expect(page.getByTestId("empty-collection")).toBeVisible({ timeout: 30000 });

    // Mark the seeded PDF as finished from its context menu.
    await page.getByRole("button", { name: "All Books" }).click();
    await waitForLibraryView(page);
    const pdfCard = page.locator(`[aria-label^="${seededBookTitles.pdf}"]`);
    await pdfCard.waitFor({ state: "visible", timeout: 30000 });
    await pdfCard.click();
    await pdfCard.click({ button: "right" });
    await expect(page.getByTestId("context-mark-finished")).toBeVisible({ timeout: 30000 });
    await page.getByTestId("context-mark-finished").click();
    await page.getByTestId("context-mark-finished").waitFor({ state: "detached", timeout: 30000 });

    // The Finished section lists the PDF; the In Progress section does not.
    await page.getByRole("button", { name: "Finished" }).click();
    await waitForLibraryView(page);
    await expect(page.getByTestId("book-card").first()).toBeVisible({ timeout: 30000 });
    const finishedText = await page.evaluate(
      () => document.querySelector("[data-testid=book-card]")?.textContent ?? "",
    );
    expect(finishedText).toContain(seededBookTitles.pdf);

    await page.getByRole("button", { name: "In Progress" }).click();
    await waitForLibraryView(page);
    // Earlier specs may have left the EPUB in progress, which is correct;
    // the finished PDF must never appear here.
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            Array.from(document.querySelectorAll("[data-testid=book-card]"))
              .map((card) => card.textContent ?? "")
              .join("\n"),
          ),
        { timeout: 30000 },
      )
      .not.toContain(seededBookTitles.pdf);

    // Reopening the context menu shows the finished confirmation, disabled.
    await page.getByRole("button", { name: "All Books" }).click();
    await waitForLibraryView(page);
    const finishedCard = page.locator(`[aria-label^="${seededBookTitles.pdf}"]`);
    await finishedCard.waitFor({ state: "visible", timeout: 30000 });
    await finishedCard.click();
    await finishedCard.click({ button: "right" });
    const finishedItem = page.getByTestId("context-mark-finished");
    await expect(finishedItem).toBeVisible({ timeout: 30000 });
    await expect(finishedItem).toHaveText("Finished");
    await expect(finishedItem).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");

    // Delete the collection: the grouping goes, the library stays. The
    // delete affordance is hover-revealed (opacity 0 until the row is
    // hovered), so the click goes through the DOM instead of a pointer.
    await page.locator("[data-testid^=collection-delete-]").waitFor({
      state: "attached",
      timeout: 30000,
    });
    await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>("[data-testid^=collection-delete-]");
      button?.click();
    });
    await page
      .locator("[data-testid^=collection-delete-]")
      .waitFor({ state: "detached", timeout: 30000 });
    await page.getByRole("button", { name: "All Books" }).click();
    await waitForLibraryView(page);
    const allCards = await page.getByTestId("book-card").all();
    expect(allCards.length).toBeGreaterThanOrEqual(2);
  });
});
