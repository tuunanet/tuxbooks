import {
  openBookDetail,
  openInReader,
  returnToLibrary,
  textOf,
  waitForLibraryView,
} from "./helpers.js";

describe("tuxbooks library navigation", () => {
  // Test B — the library shows the seeded fixtures with the sidebar up.
  // The seed carries four books: the original EPUB/PDF pair plus the large
  // (100-page) and mixed-size PDF fixtures used by the reader suites.
  it("shows All Books with the seeded fixture books", async () => {
    await waitForLibraryView();

    await expect($('[aria-label="Library sidebar"]')).toBeDisplayed();
    await expect($("button=All Books")).toBeDisplayed();

    const cards = await $$("[data-testid=book-card]");
    expect(cards.length).toBe(4);

    const cardTexts = await browser.execute(() => {
      return Array.from(document.querySelectorAll<HTMLElement>("[data-testid=book-card]")).map(
        (card) => card.textContent ?? "",
      );
    });
    const allText = cardTexts.join("\n");
    expect(allText).toContain("A Minimal Book");
    expect(allText).toContain("A Minimal Manual");
    expect(allText).toContain("A Large Fixture");
    expect(allText).toContain("Odd Sizes");

    await expect(await textOf("library-stats")).toContain("4 books");
  });

  // Test C — detail view with title and format for the EPUB fixture.
  it("opens the EPUB detail view showing title and format", async () => {
    await openBookDetail("A Minimal Book (EPUB)");

    await expect(await textOf("detail-title")).toContain("A Minimal Book");
    await expect(await textOf("detail-facts")).toContain("EPUB");

    await $("[data-testid=detail-back]").click();
    await waitForLibraryView();
  });

  // Test D — the PDF fixture opens the reader shell: toolbar visible,
  // library sidebar gone, and the real PDF.js canvas rendered.
  it("opens the PDF in the reader shell with the sidebar hidden", async () => {
    await openInReader("A Minimal Manual (PDF)");

    await expect(await textOf("reader-title")).toContain("A Minimal Manual");
    await $("[data-testid=pdf-canvas]").waitForExist({ timeout: 30000 });
    await expect($("[data-testid=reader-back]")).toBeDisplayed();
    await expect($("[data-testid=sidebar]")).not.toExist();

    await returnToLibrary();
    await expect($('[aria-label="Library sidebar"]')).toBeDisplayed();
  });

  // Milestone 5 — library search: the global search field queries the
  // backend FTS index; picking a hit (Enter) opens its detail view and
  // clears the query.
  it("finds books through the global search and opens the picked hit", async () => {
    await waitForLibraryView();

    const input = await $("[data-testid=global-search]");
    await input.click();
    await input.setValue("minimal");
    await $("[data-testid=global-search-result]").waitForDisplayed({ timeout: 30000 });
    await expect($("[data-testid=global-search-result]")).toBeDisplayed();

    await browser.keys("Enter");
    await $("[data-testid=book-detail]").waitForDisplayed({ timeout: 30000 });
    await expect($("[data-testid=global-search]")).toHaveValue("");

    await $("[data-testid=detail-back]").click();
    await waitForLibraryView();
  });
});
