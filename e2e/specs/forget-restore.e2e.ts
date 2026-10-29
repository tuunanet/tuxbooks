import { expect, test, type Page } from "../fixtures/electron-app.js";

import { seededBookTitles } from "../setup/fixtures.js";
import { ensureLibrary, waitForLibraryView } from "./helpers.js";

/**
 * Forget and restore (ADR 0014 D5, ticket tuxbooks-ip6.7): Forget moves the
 * old identity to the 30-day trash and keeps the library entry under a fresh
 * identity. Reading the fresh book and then restoring offers the deliberate
 * Replace / Keep / Merge choice; Merge keeps the newer progress and both
 * annotations.
 */
interface LibraryBook {
  id: number;
  path: string;
  title: string;
  progressPercent: number | null;
}

interface BookTrashEntry {
  id: number;
  title: string | null;
  hasNewState: boolean;
}

async function invoke<T>(page: Page, method: string, params: Record<string, unknown>): Promise<T> {
  return (await page.evaluate(([name, args]) => window.tuxbooks!.invoke(name as string, args), [
    method,
    params,
  ] as [string, Record<string, unknown>])) as T;
}

test.describe("forget and restore", () => {
  test("forget keeps the library entry and restore merges the old record", async ({ page }) => {
    await ensureLibrary(page);
    const books = await invoke<LibraryBook[]>(page, "list_books", {});
    const book = books.find((candidate) => candidate.title === seededBookTitles.epub);
    if (!book) throw new Error("the seeded EPUB is not in the library");

    // Give the old identity state worth restoring.
    await page.evaluate(async (bookId) => {
      await window.tuxbooks!.invoke("save_reading_progress", {
        bookId,
        progress: { chapterHref: "chapter1.xhtml", characterOffset: 20, progressPercent: 13 },
      });
      await window.tuxbooks!.invoke("create_annotation", {
        bookId,
        annotation: {
          kind: "bookmark",
          cfi: "epubcfi(/6/4!/4/2,/1:0,/1:8)",
          chapterHref: "chapter1.xhtml",
          text: "forget journey bookmark",
        },
      });
    }, book.id);

    // Forget through the same confirmation a reader sees.
    const card = page.locator(`[aria-label="${seededBookTitles.epub} (EPUB)"]`);
    await card.click({ button: "right" });
    await page.getByTestId("context-forget-book").click();
    const dialog = page.getByTestId("forget-book-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("30 days");
    await page.getByTestId("forget-book-confirm").click();

    // The membership never disappears; the old identity is in the trash.
    await expect(card).toHaveCount(1, { timeout: 30000 });
    await expect
      .poll(async () => {
        const current = await invoke<LibraryBook[]>(page, "list_books", {});
        return current.find((candidate) => candidate.path === book.path)?.id ?? null;
      })
      .not.toBe(book.id);
    const fresh = (await invoke<LibraryBook[]>(page, "list_books", {})).find(
      (candidate) => candidate.path === book.path,
    );
    if (!fresh) throw new Error("the forgotten book left the library");
    expect(fresh.progressPercent).toBeNull();
    expect(await invoke<unknown[]>(page, "list_annotations", { bookId: fresh.id })).toHaveLength(0);

    // New reading on the fresh identity makes restore a deliberate choice.
    await page.evaluate(async (bookId) => {
      await window.tuxbooks!.invoke("save_reading_progress", {
        bookId,
        progress: { chapterHref: "chapter2.xhtml", characterOffset: 50, progressPercent: 71 },
      });
      await window.tuxbooks!.invoke("create_annotation", {
        bookId,
        annotation: {
          kind: "highlight",
          cfi: "epubcfi(/6/4!/4/2,/1:10,/1:18)",
          chapterHref: "chapter2.xhtml",
          text: "new journey highlight",
          color: "yellow",
        },
      });
    }, fresh.id);

    await page.getByRole("button", { name: "Reading history" }).click();
    await expect(page.getByTestId("reading-history-view")).toBeVisible({ timeout: 30000 });
    const forgotten = page.getByTestId("recently-forgotten");
    await expect(forgotten).toBeVisible({ timeout: 30000 });
    await expect(forgotten).toContainText(seededBookTitles.epub);
    await expect(page.getByTestId("book-trash-new-state")).toBeVisible();

    await page.locator('[data-testid^="book-trash-restore-"]').first().click();
    const conflict = page.getByTestId("restore-book-dialog");
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText("71% progress");
    await expect(conflict).toContainText("1 annotation");
    await page.getByTestId("restore-book-merge").click();

    await expect(page.getByTestId("recently-forgotten")).toHaveCount(0, { timeout: 30000 });
    await page.getByRole("button", { name: "All Books" }).click();
    await waitForLibraryView(page);
    await expect(card).toHaveCount(1);

    const progress = await invoke<{ progressPercent: number | null } | null>(
      page,
      "get_reading_progress",
      { bookId: fresh.id },
    );
    expect(progress?.progressPercent).toBe(71);
    const annotations = await invoke<unknown[]>(page, "list_annotations", { bookId: fresh.id });
    expect(annotations).toHaveLength(2);

    // Merge consumed the trash entry, so the next spec starts clean.
    const trash = await invoke<BookTrashEntry[]>(page, "list_book_trash", {});
    expect(trash).toHaveLength(0);
  });
});
