import { seededBookTitles } from "../setup/fixtures.js";
import { ensureLibrary, waitForLibraryView } from "./helpers.js";

/**
 * Library curation surfaces (milestone 10) against the real binary: one
 * flow that creates a collection, files a book into it through the card
 * context menu, removes it again, marks a book finished, and deletes the
 * collection. The steps share one test because they build on the same
 * collection state.
 */
describe("collections and reading sections (milestone 10)", () => {
  it("creates a collection, manages membership, marks finished, and cleans up", async () => {
    await ensureLibrary();

    // Create the collection from the sidebar; creation lands in its section.
    await $("[data-testid=new-collection-button]").click();
    const dialog = await $("[data-testid=collection-dialog]");
    await dialog.waitForDisplayed({ timeout: 30000 });
    await $("[data-testid=collection-name]").setValue("Reading Queue");
    await $("[data-testid=collection-create]").click();
    await dialog.waitForDisplayed({ reverse: true, timeout: 30000 });
    await browser.waitUntil(
      async () =>
        (await $("h2=Reading Queue").isExisting()) || (await $("h3=Reading Queue").isExisting()),
      { timeout: 30000, timeoutMsg: "creation never navigated to the new collection" },
    );
    // The fresh collection is empty.
    await $("[data-testid=empty-collection]").waitForDisplayed({ timeout: 30000 });

    // Add the seeded EPUB through the card's context menu.
    await $("button=All Books").click();
    await waitForLibraryView();
    const card = await $(`[aria-label^="${seededBookTitles.epub}"]`);
    await card.waitForDisplayed({ timeout: 30000 });
    await card.click();
    await card.click({ button: "right" });
    await $("[data-testid=context-add-to-collection]").waitForDisplayed({ timeout: 30000 });
    await $("[data-testid=context-add-to-collection]").click();
    const addEntry = await $("[data-testid^=context-add-to-collection-]");
    await addEntry.waitForDisplayed({ timeout: 30000 });
    await addEntry.click();
    // The menu closes after the selection.
    await $("[data-testid=context-add-to-collection]").waitForDisplayed({
      reverse: true,
      timeout: 30000,
    });

    // The collection section lists exactly the member book.
    await $("button=Reading Queue").click();
    await waitForLibraryView();
    await $("[data-testid=book-card]").waitForDisplayed({ timeout: 30000 });
    const memberCards = await $$("[data-testid=book-card]");
    expect(memberCards).toHaveLength(1);
    const memberText = await browser.execute(
      () => document.querySelector("[data-testid=book-card]")?.textContent ?? "",
    );
    expect(memberText).toContain(seededBookTitles.epub);

    // Remove the membership again from the same context menu.
    const memberCard = await $("[data-testid=book-card]");
    await memberCard.click();
    await memberCard.click({ button: "right" });
    await $("[data-testid=context-remove-from-collection]").waitForDisplayed({ timeout: 30000 });
    await $("[data-testid=context-remove-from-collection]").click();
    const removeEntry = await $("[data-testid^=context-remove-from-collection-]");
    await removeEntry.waitForDisplayed({ timeout: 30000 });
    await removeEntry.click();
    // The section empties out live.
    await $("[data-testid=empty-collection]").waitForDisplayed({ timeout: 30000 });

    // Mark the seeded PDF as finished from its context menu.
    await $("button=All Books").click();
    await waitForLibraryView();
    const pdfCard = await $(`[aria-label^="${seededBookTitles.pdf}"]`);
    await pdfCard.waitForDisplayed({ timeout: 30000 });
    await pdfCard.click();
    await pdfCard.click({ button: "right" });
    const markFinished = await $("[data-testid=context-mark-finished]");
    await markFinished.waitForDisplayed({ timeout: 30000 });
    await markFinished.click();
    await $("[data-testid=context-mark-finished]").waitForDisplayed({
      reverse: true,
      timeout: 30000,
    });

    // The Finished section lists the PDF; the In Progress section does not.
    await $("button=Finished").click();
    await waitForLibraryView();
    await $("[data-testid=book-card]").waitForDisplayed({ timeout: 30000 });
    const finishedText = await browser.execute(
      () => document.querySelector("[data-testid=book-card]")?.textContent ?? "",
    );
    expect(finishedText).toContain(seededBookTitles.pdf);

    await $("button=In Progress").click();
    await waitForLibraryView();
    // Earlier specs may have left the EPUB in progress, which is correct;
    // the finished PDF must never appear here.
    await browser.waitUntil(
      async () => {
        const texts = await browser.execute(() =>
          Array.from(document.querySelectorAll("[data-testid=book-card]"))
            .map((card) => card.textContent ?? "")
            .join("\n"),
        );
        return !texts.includes(seededBookTitles.pdf);
      },
      { timeout: 30000, timeoutMsg: "the finished book leaked into In Progress" },
    );

    // Reopening the context menu shows the finished confirmation, disabled.
    await $("button=All Books").click();
    await waitForLibraryView();
    const finishedCard = await $(`[aria-label^="${seededBookTitles.pdf}"]`);
    await finishedCard.waitForDisplayed({ timeout: 30000 });
    await finishedCard.click();
    await finishedCard.click({ button: "right" });
    const finishedItem = await $("[data-testid=context-mark-finished]");
    await finishedItem.waitForDisplayed({ timeout: 30000 });
    expect(await finishedItem.getText()).toBe("Finished");
    expect(await finishedItem.getAttribute("aria-disabled")).toBe("true");
    await browser.keys("Escape");

    // Delete the collection: the grouping goes, the library stays. The
    // delete affordance is hover-revealed (opacity 0 until the row is
    // hovered), so the click goes through the DOM instead of a pointer.
    await $("[data-testid^=collection-delete-]").waitForExist({ timeout: 30000 });
    await browser.execute(() => {
      const button = document.querySelector<HTMLElement>("[data-testid^=collection-delete-]");
      button?.click();
    });
    await browser.waitUntil(
      async () => !(await $("[data-testid^=collection-delete-]").isExisting()),
      { timeout: 30000, timeoutMsg: "collection delete never landed" },
    );
    await $("button=All Books").click();
    await waitForLibraryView();
    const allCards = await $$("[data-testid=book-card]");
    expect(allCards.length).toBeGreaterThanOrEqual(2);
  });
});
