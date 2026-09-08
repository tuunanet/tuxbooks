import { expect, test } from "../fixtures/electron-app.js";

import {
  firstPdfCanvas,
  openBookDetail,
  openInReader,
  returnToLibrary,
  textOf,
  waitForLibraryView,
} from "./helpers.js";

test.describe("tuxbooks library navigation", () => {
  // Test B — the library shows the seeded fixtures with the sidebar up.
  // The seed carries four books: the original EPUB/PDF pair plus the large
  // (100-page) and mixed-size PDF fixtures used by the reader suites.
  test("shows All Books with the seeded fixture books", async ({ page }) => {
    await waitForLibraryView(page);

    await expect(page.locator('[aria-label="Library sidebar"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "All Books" })).toBeVisible();

    const cards = await page.getByTestId("book-card").all();
    expect(cards.length).toBe(4);

    const allText = await page.evaluate(() =>
      Array.from(document.querySelectorAll<HTMLElement>("[data-testid=book-card]"))
        .map((card) => card.textContent ?? "")
        .join("\n"),
    );
    expect(allText).toContain("A Minimal Book");
    expect(allText).toContain("A Minimal Manual");
    expect(allText).toContain("A Large Fixture");
    expect(allText).toContain("Odd Sizes");

    expect(await textOf(page, "library-stats")).toContain("4 books");
  });

  // Test C — detail view with title and format for the EPUB fixture.
  test("opens the EPUB detail view showing title and format", async ({ page }) => {
    await openBookDetail(page, "A Minimal Book (EPUB)");

    expect(await textOf(page, "detail-title")).toContain("A Minimal Book");
    expect(await textOf(page, "detail-facts")).toContain("EPUB");

    await page.getByTestId("detail-back").click();
    await waitForLibraryView(page);
  });

  // Test D — the PDF fixture opens the reader shell: toolbar visible,
  // library sidebar gone, and the real engine canvas rendered.
  test("opens the PDF in the reader shell with the sidebar hidden", async ({ page }) => {
    await openInReader(page, "A Minimal Manual (PDF)");

    expect(await textOf(page, "reader-title")).toContain("A Minimal Manual");
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    await expect(page.getByTestId("reader-back")).toBeVisible();
    await expect(page.getByTestId("sidebar")).toHaveCount(0);

    await returnToLibrary(page);
    await expect(page.locator('[aria-label="Library sidebar"]')).toBeVisible();
  });

  // Milestone 5 — library search: the global search field queries the
  // backend FTS index; picking a hit (Enter) opens its detail view and
  // clears the query.
  test("finds books through the global search and opens the picked hit", async ({ page }) => {
    await waitForLibraryView(page);

    const input = page.getByTestId("global-search");
    await input.click();
    await input.fill("minimal");
    // Both minimal fixtures match "minimal"; the ranked first hit opens.
    const result = page.getByTestId("global-search-result").first();
    await expect(result).toBeVisible({ timeout: 30000 });

    await page.keyboard.press("Enter");
    await expect(page.getByTestId("book-detail")).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId("global-search")).toHaveValue("");

    await page.getByTestId("detail-back").click();
    await waitForLibraryView(page);
  });
});
