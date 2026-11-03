import type { Locator } from "playwright";

import { expect, launchElectronApp, test, type Page } from "../fixtures/electron-app.js";

import { seededBookTitles } from "../setup/fixtures.js";
import { ensureLibrary, waitForLibraryView } from "./helpers.js";

/**
 * The collections redesign as one user journey: create collections, pin and
 * unpin, drag inside Pinned and across the Pinned/Unpinned boundary,
 * Ctrl/Shift multi-select, the union title, Added to collection sorting,
 * rename, confirmed delete, and command-palette selection. The final step
 * closes the app and opens it again, asserting the per-device pin state and
 * custom order survive the restart.
 *
 * Own Playwright phase ("collections", e2e/package.json test:collections):
 * the restart tears down and relaunches the worker's app, which must not
 * share a worker with the other seeded suites (same rule as the shell and
 * gpu phases). The phase seeds the normal fixture library.
 */

const names = {
  alpha: "Alpha Shelf",
  beta: "Beta Shelf",
  gamma: "Gamma Shelf",
  delta: "Delta Shelf",
  epsilon: "Epsilon Shelf",
} as const;
const renamedAlpha = "Alpha Renamed";

/** The sidebar row for a collection, independent of its database id. */
function collectionRow(page: Page, name: string): Locator {
  return page.locator("[data-collection-row]").filter({ hasText: name });
}

async function collectionId(page: Page, name: string): Promise<number> {
  const raw = await collectionRow(page, name).getAttribute("data-collection-row");
  if (raw === null) throw new Error(`collection row "${name}" is not in the sidebar`);
  return Number(raw);
}

/** Rendered collection names in one group, in sidebar order. */
async function groupNames(page: Page, group: "pinned" | "unpinned"): Promise<string[]> {
  const section = page.getByTestId(`${group}-collections`);
  if ((await section.count()) === 0) return [];
  return section
    .locator("[data-collection-row]")
    .evaluateAll((rows) =>
      rows.map(
        (row) => row.querySelector('[data-testid="collection-item"]')?.textContent?.trim() ?? "",
      ),
    );
}

async function expectGroupOrder(
  page: Page,
  group: "pinned" | "unpinned",
  expected: string[],
): Promise<void> {
  await expect
    .poll(() => groupNames(page, group), {
      timeout: 30_000,
      message: `${group} collections never reached ${JSON.stringify(expected)}`,
    })
    .toEqual(expected);
}

async function clickCollection(
  page: Page,
  name: string,
  modifiers: ("Control" | "Shift")[] = [],
): Promise<void> {
  await collectionRow(page, name).getByTestId("collection-item").click({ modifiers });
  await waitForLibraryView(page);
}

async function createCollection(page: Page, name: string): Promise<void> {
  await page.getByTestId("new-collection-button").click();
  const dialog = page.getByTestId("collection-dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("collection-name").fill(name);
  await page.getByTestId("collection-create").click();
  await dialog.waitFor({ state: "detached", timeout: 30_000 });
  // Creation lands in the new collection's empty place.
  await expect(page.getByTestId("library-header").getByRole("heading", { name })).toBeVisible({
    timeout: 30_000,
  });
  await expect(collectionRow(page, name)).toBeVisible({ timeout: 30_000 });
}

/** Opens the row's actions menu (hover-revealed) and returns its collection id. */
async function openRowActions(page: Page, name: string): Promise<number> {
  const row = collectionRow(page, name);
  await row.hover();
  const id = await collectionId(page, name);
  await page.getByTestId(`collection-actions-${id}`).click();
  await expect(page.getByRole("menu")).toBeVisible({ timeout: 30_000 });
  return id;
}

async function setPinned(page: Page, name: string, pinned: boolean): Promise<void> {
  const id = await openRowActions(page, name);
  await page.getByTestId(`collection-${pinned ? "pin" : "unpin"}-${id}`).click();
}

async function renameCollection(page: Page, from: string, to: string): Promise<void> {
  const id = await openRowActions(page, from);
  await page.getByTestId(`collection-rename-${id}`).click();
  const dialog = page.getByTestId("collection-dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("collection-name")).toHaveValue(from);
  await page.getByTestId("collection-name").fill(to);
  await page.getByTestId("collection-rename").click();
  await dialog.waitFor({ state: "detached", timeout: 30_000 });
  await expect(collectionRow(page, to)).toBeVisible({ timeout: 30_000 });
  await expect(collectionRow(page, from)).toHaveCount(0);
}

/** Drag a row by its handle, landing above or below a target row. */
async function dragCollection(
  page: Page,
  source: string,
  target: string,
  where: "above" | "below",
): Promise<void> {
  const sourceId = await collectionId(page, source);
  await collectionRow(page, source).hover();
  const handle = page.getByTestId(`collection-drag-${sourceId}`);
  const from = await handle.boundingBox();
  const to = await collectionRow(page, target).boundingBox();
  if (!from || !to) throw new Error(`drag geometry missing for ${source} -> ${target}`);
  const cursorX = to.x + to.width / 2;
  const cursorY = where === "above" ? to.y + 2 : to.y + to.height - 2;

  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(cursorX, cursorY, { steps: 8 });
  await page.waitForTimeout(100);
  await page.mouse.up();
}

async function addBookToCollection(
  page: Page,
  bookTitle: string,
  targetCollectionId: number,
): Promise<void> {
  await page.getByRole("button", { name: "All Books" }).click();
  await waitForLibraryView(page);
  const card = page.locator(`[aria-label^="${bookTitle}"]`);
  await card.waitFor({ state: "visible", timeout: 30_000 });
  await card.click();
  await card.click({ button: "right" });
  await expect(page.getByTestId("context-add-to-collection")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("context-add-to-collection").click();
  const entry = page.getByTestId(`context-add-to-collection-${targetCollectionId}`);
  await expect(entry).toBeVisible({ timeout: 30_000 });
  await entry.click();
  await page
    .getByTestId("context-add-to-collection")
    .waitFor({ state: "detached", timeout: 30_000 });
}

async function bookIdByTitle(page: Page, title: string): Promise<number | null> {
  return page.evaluate(async (needle) => {
    const books = (await window.tuxbooks!.invoke("list_books")) as {
      id: number;
      title: string;
    }[];
    return books.find((book) => book.title === needle)?.id ?? null;
  }, title);
}

async function membershipDates(page: Page, id: number): Promise<Record<string, string>> {
  return page.evaluate(async (collectionId) => {
    const collections = (await window.tuxbooks!.invoke("list_collections")) as {
      id: number;
      memberships: { bookId: number; addedAt: string }[];
    }[];
    const found = collections.find((collection) => collection.id === collectionId);
    return Object.fromEntries(
      (found?.memberships ?? []).map((membership) => [
        String(membership.bookId),
        membership.addedAt,
      ]),
    );
  }, id);
}

async function bookCardLabels(page: Page): Promise<string[]> {
  return page
    .getByTestId("book-card")
    .evaluateAll((cards) => cards.map((card) => card.getAttribute("aria-label") ?? ""));
}

async function selectSort(page: Page, label: string): Promise<void> {
  await page.getByTestId("library-sort").click();
  const option = page.getByRole("option", { name: label, exact: true });
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
  await expect(page.getByTestId("library-sort")).toContainText(label);
}

/**
 * Leave no collections behind when a retry reuses the phase database. The
 * normal run starts empty; the bridge cleanup keeps a second attempt from
 * stacking duplicate names on the first attempt's rows.
 */
async function resetCollections(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const collections = (await window.tuxbooks!.invoke("list_collections")) as { id: number }[];
    for (const collection of collections) {
      await window.tuxbooks!.invoke("delete_collection", { collectionId: collection.id });
    }
  });
  await page.reload();
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
  await waitForLibraryView(page);
}

test.describe("collections redesign journey", () => {
  test("creates, pins, reorders, multi-selects, sorts, renames, deletes, and restores after restart", async ({
    electronApp,
    page,
  }) => {
    test.setTimeout(240_000);
    await ensureLibrary(page);
    await resetCollections(page);

    // New collections are unpinned and land in the Unpinned group.
    for (const name of Object.values(names)) {
      await createCollection(page, name);
    }
    // Alphabetical until the first drag.
    await expectGroupOrder(page, "unpinned", [
      names.alpha,
      names.beta,
      names.delta,
      names.epsilon,
      names.gamma,
    ]);

    // Pin from the row actions menu, then unpin back to Unpinned.
    await setPinned(page, names.alpha, true);
    await expectGroupOrder(page, "pinned", [names.alpha]);
    await expectGroupOrder(page, "unpinned", [names.beta, names.delta, names.epsilon, names.gamma]);
    await setPinned(page, names.alpha, false);
    await expectGroupOrder(page, "pinned", []);
    await expectGroupOrder(page, "unpinned", [
      names.alpha,
      names.beta,
      names.delta,
      names.epsilon,
      names.gamma,
    ]);

    // Two pinned rows give the drag inside Pinned something to reorder.
    await setPinned(page, names.alpha, true);
    await setPinned(page, names.gamma, true);
    await expectGroupOrder(page, "pinned", [names.alpha, names.gamma]);
    await dragCollection(page, names.alpha, names.gamma, "below");
    await expectGroupOrder(page, "pinned", [names.gamma, names.alpha]);

    // Dragging across the boundary pins; dragging back unpins. Unpinned keeps
    // its custom order afterwards (Epsilon before Beta).
    await dragCollection(page, names.beta, names.gamma, "above");
    await expectGroupOrder(page, "pinned", [names.beta, names.gamma, names.alpha]);
    await expectGroupOrder(page, "unpinned", [names.delta, names.epsilon]);
    await dragCollection(page, names.beta, names.epsilon, "below");
    await expectGroupOrder(page, "pinned", [names.gamma, names.alpha]);
    await expectGroupOrder(page, "unpinned", [names.delta, names.epsilon, names.beta]);

    // Membership to sort: two books in Alpha, one in Gamma.
    const alphaId = await collectionId(page, names.alpha);
    const gammaId = await collectionId(page, names.gamma);
    await addBookToCollection(page, seededBookTitles.epub, alphaId);
    // The membership timestamp has millisecond resolution; a short pause
    // keeps the two Alpha memberships in a known Added to collection order.
    await page.waitForTimeout(50);
    await addBookToCollection(page, seededBookTitles.pdf, alphaId);
    await addBookToCollection(page, seededBookTitles.largePdf, gammaId);

    const epubId = await bookIdByTitle(page, seededBookTitles.epub);
    const pdfId = await bookIdByTitle(page, seededBookTitles.pdf);
    if (epubId === null || pdfId === null) throw new Error("seeded books are missing");
    const dates = await membershipDates(page, alphaId);
    const epubJoined = dates[String(epubId)];
    const pdfJoined = dates[String(pdfId)];
    if (!epubJoined || !pdfJoined) throw new Error("Alpha memberships are missing");
    expect(pdfJoined > epubJoined).toBe(true);

    // Inside Alpha the date sort is renamed Added to collection. Title order
    // is EPUB then PDF; membership order is the reverse because the PDF
    // joined later, so switching the sort visibly reorders the members.
    await clickCollection(page, names.alpha);
    await expect(
      page.getByTestId("library-header").getByRole("heading", { name: names.alpha }),
    ).toBeVisible({ timeout: 30_000 });
    const epubCard = `${seededBookTitles.epub} (EPUB)`;
    const pdfCard = `${seededBookTitles.pdf} (PDF)`;

    await selectSort(page, "Title");
    await expect.poll(() => bookCardLabels(page), { timeout: 30_000 }).toEqual([epubCard, pdfCard]);

    await selectSort(page, "Added to collection");
    await expect(page.getByTestId("library-sort")).toContainText("Added to collection");
    await expect.poll(() => bookCardLabels(page), { timeout: 30_000 }).toEqual([pdfCard, epubCard]);

    // Ctrl+click two collections: the title names both in sidebar order and
    // the grid shows the union of their members.
    await page.getByRole("button", { name: "All Books" }).click();
    await waitForLibraryView(page);
    await clickCollection(page, names.alpha, ["Control"]);
    await clickCollection(page, names.gamma, ["Control"]);
    await expect(
      page.getByTestId("library-header").getByRole("heading", {
        name: `${names.gamma} and ${names.alpha}`,
      }),
    ).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => bookCardLabels(page), { timeout: 30_000 })
      .toEqual(expect.arrayContaining([epubCard, pdfCard, `${seededBookTitles.largePdf} (PDF)`]));
    await expect(page.getByTestId("book-card")).toHaveCount(3);

    // Shift+click a range from the pinned Gamma row across the boundary to
    // the unpinned Delta row: three collections selected, Beta outside it.
    await clickCollection(page, names.delta, ["Shift"]);
    await expect(
      page.getByTestId("library-header").getByRole("heading", { name: "3 collections" }),
    ).toBeVisible({ timeout: 30_000 });
    for (const selected of [names.gamma, names.alpha, names.delta]) {
      await expect(
        collectionRow(page, selected).locator('button[aria-current="true"]'),
      ).toHaveCount(1);
    }
    await expect(
      collectionRow(page, names.beta).locator('button[aria-current="true"]'),
    ).toHaveCount(0);

    // Rename updates the sidebar row and the library title of the place.
    await clickCollection(page, names.alpha);
    await renameCollection(page, names.alpha, renamedAlpha);
    await expect(
      page.getByTestId("library-header").getByRole("heading", { name: renamedAlpha }),
    ).toBeVisible({ timeout: 30_000 });

    // Delete asks first: cancel keeps the row, confirm removes it.
    await collectionRow(page, names.epsilon).hover();
    const epsilonId = await collectionId(page, names.epsilon);
    await page.getByTestId(`collection-delete-${epsilonId}`).click();
    const deleteDialog = page.getByTestId("delete-collection-dialog");
    await expect(deleteDialog).toBeVisible({ timeout: 30_000 });
    await expect(deleteDialog).toContainText(`Delete ${names.epsilon}?`);
    await page.getByTestId("delete-collection-cancel").click();
    await deleteDialog.waitFor({ state: "detached", timeout: 30_000 });
    await expect(collectionRow(page, names.epsilon)).toBeVisible({ timeout: 30_000 });

    await page.getByTestId(`collection-delete-${epsilonId}`).click();
    await expect(deleteDialog).toBeVisible({ timeout: 30_000 });
    await page.getByTestId("delete-collection-confirm").click();
    await expect(collectionRow(page, names.epsilon)).toHaveCount(0);
    await expectGroupOrder(page, "unpinned", [names.delta, names.beta]);

    // The command palette lists collections above books; Enter lands in the
    // highlighted collection.
    await page.keyboard.press("Control+k");
    const search = page.getByTestId("global-search");
    await expect(search).toBeFocused();
    await search.fill("A");
    await expect(page.getByTestId("global-search-result").first()).toContainText(renamedAlpha);
    // Book hits arrive from the backend after the debounce; the collection
    // group is client-side and renders first.
    await expect(page.locator("#global-search-collections-label")).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator("#global-search-books-label")).toBeVisible({ timeout: 30_000 });
    const collectionsAboveBooks = await page.evaluate(() => {
      const collections = document.getElementById("global-search-collections-label");
      const books = document.getElementById("global-search-books-label");
      if (!collections || !books) return false;
      return Boolean(collections.compareDocumentPosition(books) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(collectionsAboveBooks).toBe(true);
    await page.keyboard.press("Enter");
    await expect(
      page.getByTestId("library-header").getByRole("heading", { name: renamedAlpha }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(search).toHaveValue("");

    // Restart: pin membership and custom order are device preferences, so a
    // fresh launch must render the same Pinned and Unpinned groups.
    const expectedGroups = {
      pinned: [names.gamma, renamedAlpha],
      unpinned: [names.delta, names.beta],
    };
    await electronApp.close();
    const relaunched = await launchElectronApp();
    try {
      const restarted = await relaunched.firstWindow();
      await restarted.emulateMedia({ colorScheme: "light" });
      await expect(restarted.getByTestId("app-shell")).toBeVisible({ timeout: 30_000 });
      await waitForLibraryView(restarted);
      await expectGroupOrder(restarted, "pinned", expectedGroups.pinned);
      await expectGroupOrder(restarted, "unpinned", expectedGroups.unpinned);
    } finally {
      await relaunched.close();
    }
  });
});
