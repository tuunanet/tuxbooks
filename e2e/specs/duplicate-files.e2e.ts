import { copyFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "../fixtures/electron-app.js";

import { seededBookTitles } from "../setup/fixtures.js";
import { ensureLibrary, openBookDetail, waitForLibraryView } from "./helpers.js";

/**
 * Duplicate file copies (ADR 0014 D7, ticket tuxbooks-ip6.6): a second file
 * with identical bytes joins the existing durable book, the library keeps one
 * entry, the details list both locations, storage counts both files' bytes,
 * and removing one copy leaves the book and its reading state intact.
 */
interface LibraryBook {
  id: number;
  path: string;
  title: string;
}

interface BookFile {
  id: number;
  path: string;
  active: boolean;
}

interface StorageStats {
  catalog: { books: number };
  bookTotalBytes: number;
}

async function invoke<T>(page: Page, method: string, params: Record<string, unknown>): Promise<T> {
  return (await page.evaluate(([name, args]) => window.tuxbooks!.invoke(name as string, args), [
    method,
    params,
  ] as [string, Record<string, unknown>])) as T;
}

test.describe("duplicate files", () => {
  test("one library entry lists every copy and survives removing one", async ({ page }) => {
    await ensureLibrary(page);
    const before = await invoke<LibraryBook[]>(page, "list_books", {});
    const book = before.find((candidate) => candidate.title === seededBookTitles.epub);
    if (!book) throw new Error("the seeded EPUB is not in the library");
    const storageBefore = await invoke<StorageStats>(page, "get_storage_stats", {});

    // The copy has identical bytes, so the importer must attach it to the
    // existing book instead of minting a second entry.
    const copyPath = path.join(path.dirname(book.path), "duplicate-copy.epub");
    copyFileSync(book.path, copyPath);
    const copyBytes = statSync(copyPath).size;
    try {
      await page.evaluate(async (path) => {
        await window.tuxbooks!.invoke("import_paths", { paths: [path] });
      }, copyPath);

      const afterImport = await invoke<LibraryBook[]>(page, "list_books", {});
      expect(afterImport.filter((candidate) => candidate.title === book.title)).toHaveLength(1);
      expect(afterImport).toHaveLength(before.length);

      const files = await invoke<BookFile[]>(page, "list_book_files", { bookId: book.id });
      expect(files).toHaveLength(2);
      expect(files.map((file) => file.path).sort()).toEqual([book.path, copyPath].sort());

      // Storage counts the book once but both files' bytes.
      const storage = await invoke<StorageStats>(page, "get_storage_stats", {});
      expect(storage.catalog.books).toBe(storageBefore.catalog.books);
      expect(storage.bookTotalBytes).toBe(storageBefore.bookTotalBytes + copyBytes);

      // A progress update through the one entry is shared by both copies.
      await page.evaluate(async (bookId) => {
        await window.tuxbooks!.invoke("save_reading_progress", {
          bookId,
          progress: {
            chapterHref: "chapter1.xhtml",
            characterOffset: 120,
            progressPercent: 61,
          },
        });
      }, book.id);

      await openBookDetail(page, `${book.title} (EPUB)`);
      const locations = page.getByTestId("detail-file-locations");
      await expect(locations).toContainText(book.path, { timeout: 30000 });
      await expect(locations).toContainText(copyPath);
      await expect(locations.getByTestId(/^detail-file-active-/)).toHaveCount(1);

      const duplicate = files.find((file) => file.path === copyPath);
      if (!duplicate) throw new Error("the duplicate location is missing");
      await page.getByTestId(`detail-file-remove-${duplicate.id}`).click();

      // The book stays in the library through the original copy, the details
      // drop the removed location, and the reading position is untouched.
      await expect(locations.locator("li")).toHaveCount(1, { timeout: 30000 });
      await expect(page.getByTestId("detail-title")).toHaveText(book.title);
      const remaining = await invoke<LibraryBook[]>(page, "list_books", {});
      const survivor = remaining.find((candidate) => candidate.id === book.id);
      expect(survivor?.path).toBe(book.path);
      const progress = await invoke<{ progressPercent: number | null } | null>(
        page,
        "get_reading_progress",
        { bookId: book.id },
      );
      expect(progress?.progressPercent).toBe(61);

      // Removing the membership row does not delete the file; this suite does,
      // so the shared scratch library stays at its seeded size.
      const afterRemove = await invoke<StorageStats>(page, "get_storage_stats", {});
      expect(afterRemove.bookTotalBytes).toBe(storageBefore.bookTotalBytes);
      expect(afterRemove.catalog.books).toBe(storageBefore.catalog.books);
    } finally {
      rmSync(copyPath, { force: true });
      await page
        .getByTestId("detail-back")
        .click()
        .catch(() => {});
      await waitForLibraryView(page);
    }
  });
});
