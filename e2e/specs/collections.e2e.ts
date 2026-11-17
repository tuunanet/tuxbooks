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
    await page
      .getByTestId("context-add-to-collection")
      .waitFor({ state: "detached", timeout: 30000 });

    // The row's action buttons carry accessible names containing the
    // collection name, so click the row's label instead of the first button.
    await page
      .locator("[data-collection-row]")
      .filter({ hasText: "Reading Queue" })
      .getByTestId("collection-item")
      .click();
    await waitForLibraryView(page);
    await expect(page.getByTestId("book-card").first()).toBeVisible({ timeout: 30000 });
    const memberCards = await page.getByTestId("book-card").all();
    expect(memberCards).toHaveLength(1);
    const memberText = await page.evaluate(
      () => document.querySelector("[data-testid=book-card]")?.textContent ?? "",
    );
    expect(memberText).toContain(seededBookTitles.epub);

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
    await expect(page.getByTestId("empty-collection")).toBeVisible({ timeout: 30000 });

    await page.getByRole("button", { name: "All Books" }).click();
    await waitForLibraryView(page);
    const pdfCard = page.locator(`[aria-label^="${seededBookTitles.pdf}"]`);
    await pdfCard.waitFor({ state: "visible", timeout: 30000 });
    await pdfCard.click();
    await pdfCard.click({ button: "right" });
    await expect(page.getByTestId("context-mark-finished")).toBeVisible({ timeout: 30000 });
    await page.getByTestId("context-mark-finished").click();
    await page.getByTestId("context-mark-finished").waitFor({ state: "detached", timeout: 30000 });

    await page.getByRole("button", { name: "Finished" }).click();
    await waitForLibraryView(page);
    await expect(page.getByTestId("book-card").first()).toBeVisible({ timeout: 30000 });
    const finishedText = await page.evaluate(
      () => document.querySelector("[data-testid=book-card]")?.textContent ?? "",
    );
    expect(finishedText).toContain(seededBookTitles.pdf);

    await page.getByRole("button", { name: "In Progress" }).click();
    await waitForLibraryView(page);
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

    // The delete affordance is opacity-0 until hover, so click through the DOM.
    const deleteButton = page.locator("[data-testid^=collection-delete-]");
    await deleteButton.waitFor({ state: "attached", timeout: 30000 });
    await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>("[data-testid^=collection-delete-]");
      button?.click();
    });
    const deleteDialog = page.getByTestId("delete-collection-dialog");
    await expect(deleteDialog).toBeVisible({ timeout: 30000 });
    await expect(deleteDialog).toContainText("Delete Reading Queue?");
    await page.getByTestId("delete-collection-confirm").click();
    await expect(deleteButton).toHaveCount(0, { timeout: 30000 });
    await page.getByRole("button", { name: "All Books" }).click();
    await waitForLibraryView(page);
    const allCards = await page.getByTestId("book-card").all();
    expect(allCards.length).toBeGreaterThanOrEqual(2);
  });
});
