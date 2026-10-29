import { expect, test, type Page } from "../fixtures/electron-app.js";

import { seededBookTitles } from "../setup/fixtures.js";
import { ensureLibrary, openBookDetail, waitForLibraryView } from "./helpers.js";

/**
 * Reading history (ADR 0014, ticket tuxbooks-ip6.5): a book with no file row
 * leaves the membership-only library, appears in its own view with the
 * durable state, and returns to the library when the same bytes are imported
 * again. The native Relink picker itself is covered by sidecar and component
 * tests; this journey exercises the headline remove → history → return flow.
 */
interface LibraryBook {
  id: number;
  path: string;
  title: string;
}

async function invoke<T>(page: Page, method: string, params: Record<string, unknown>): Promise<T> {
  return (await page.evaluate(([name, args]) => window.tuxbooks!.invoke(name as string, args), [
    method,
    params,
  ] as [string, Record<string, unknown>])) as T;
}

test.describe("reading history", () => {
  test("a removed book appears in Reading history and returns with its state", async ({ page }) => {
    await ensureLibrary(page);
    const books = await invoke<LibraryBook[]>(page, "list_books", {});
    const book = books.find((candidate) => candidate.title === seededBookTitles.epub);
    if (!book) throw new Error("the seeded EPUB is not in the library");
    const annotationsBefore = (
      await invoke<unknown[]>(page, "list_annotations", { bookId: book.id })
    ).length;
    const annotationsAfter = annotationsBefore + 1;
    const annotationLabel = `${annotationsAfter} ${
      annotationsAfter === 1 ? "annotation" : "annotations"
    }`;

    // Read and annotate through the same commands the reader uses, then end
    // the membership without touching the file on disk.
    await page.evaluate(async (bookId) => {
      await window.tuxbooks!.invoke("save_reading_progress", {
        bookId,
        progress: {
          chapterHref: "chapter1.xhtml",
          characterOffset: 120,
          progressPercent: 37,
        },
      });
      await window.tuxbooks!.invoke("create_annotation", {
        bookId,
        annotation: {
          kind: "bookmark",
          cfi: "epubcfi(/6/4!/4/2,/1:0,/1:8)",
          chapterHref: "chapter1.xhtml",
          text: "history bookmark",
        },
      });
      await window.tuxbooks!.invoke("remove_book", { bookId });
    }, book.id);

    // The library is membership-only; the book's durable state is visible in
    // the separate Reading history surface.
    await page.getByRole("button", { name: "All Books" }).click();
    await waitForLibraryView(page);
    await expect(page.locator(`[aria-label="${seededBookTitles.epub} (EPUB)"]`)).toHaveCount(0);

    await page.getByRole("button", { name: "Reading history" }).click();
    await expect(page.getByTestId("reading-history-view")).toBeVisible({ timeout: 30000 });
    // Other suites may already have left books in this shared app's history;
    // find this journey's row by title instead of assuming it is alone.
    const row = page.getByTestId("reading-history-book").filter({ hasText: seededBookTitles.epub });
    await expect(row).toHaveCount(1, { timeout: 30000 });
    await expect(row.getByTestId("reading-history-progress")).toHaveText("37% read");
    await expect(row.getByTestId("reading-history-annotations")).toHaveText(annotationLabel);

    // Importing the same bytes again attaches the file to the existing
    // durable book; its Reading history row disappears and the library entry
    // returns.
    await page.evaluate(async (path) => {
      await window.tuxbooks!.invoke("import_paths", { paths: [path] });
    }, book.path);

    await expect(row).toHaveCount(0, { timeout: 30000 });
    await page.getByRole("button", { name: "All Books" }).click();
    await waitForLibraryView(page);
    await expect(page.locator(`[aria-label="${seededBookTitles.epub} (EPUB)"]`)).toHaveCount(1);

    const returned = (await invoke<LibraryBook[]>(page, "list_books", {})).find(
      (candidate) => candidate.path === book.path,
    );
    expect(returned?.id).toBe(book.id);
    const progress = await invoke<{ progressPercent: number | null } | null>(
      page,
      "get_reading_progress",
      { bookId: book.id },
    );
    expect(progress?.progressPercent).toBe(37);
    const annotations = await invoke<unknown[]>(page, "list_annotations", { bookId: book.id });
    expect(annotations).toHaveLength(annotationsAfter);
  });

  test("a confirmed cross-edition link copies the percentage, not annotations", async ({
    page,
  }) => {
    await ensureLibrary(page);
    const books = await invoke<LibraryBook[]>(page, "list_books", {});
    const source = books.find((candidate) => candidate.title === seededBookTitles.epub);
    const target = books.find((candidate) => candidate.title === seededBookTitles.pdf);
    if (!source || !target) throw new Error("the seeded EPUB and PDF must both be in the library");

    // Keep the target unread so the copied percentage is unambiguous.
    await invoke(page, "reset_book_reading_data", { bookId: target.id });
    const annotationsBefore = (
      await invoke<unknown[]>(page, "list_annotations", { bookId: source.id })
    ).length;

    // The original edition carries progress and annotations, then leaves the
    // library for Reading history.
    await page.evaluate(async (sourceId) => {
      await window.tuxbooks!.invoke("save_reading_progress", {
        bookId: sourceId,
        progress: { chapterHref: "chapter1.xhtml", progressPercent: 37 },
      });
      await window.tuxbooks!.invoke("remove_book", { bookId: sourceId });
    }, source.id);

    await page.getByRole("button", { name: "Reading history" }).click();
    const historyRow = page
      .getByTestId("reading-history-book")
      .filter({ hasText: seededBookTitles.epub });
    await expect(historyRow).toHaveCount(1, { timeout: 30000 });
    await expect(historyRow.getByTestId("reading-history-progress")).toHaveText("37% read");

    // From the current edition's detail, confirm the other edition and see
    // the one-way state transfer spelled out before committing.
    await page.getByRole("button", { name: "All Books" }).click();
    await waitForLibraryView(page);
    await openBookDetail(page, `${seededBookTitles.pdf} (PDF)`);
    await page.getByTestId("detail-link-edition").click();

    const dialog = page.getByTestId("link-edition-dialog");
    await expect(dialog).toBeVisible({ timeout: 30000 });
    await expect(dialog.getByTestId("link-edition-annotation-note")).toContainText(
      "do not move automatically",
    );
    const sourceOption = page
      .getByTestId("link-edition-select")
      .locator("option", { hasText: seededBookTitles.epub })
      .first();
    const sourceValue = await sourceOption.getAttribute("value");
    if (!sourceValue) throw new Error("the Reading-history edition is not a link candidate");
    await page.getByTestId("link-edition-select").selectOption(sourceValue);
    await page.getByTestId("link-edition-confirm").click();

    await expect(page.getByTestId("detail-editions")).toContainText(seededBookTitles.epub, {
      timeout: 30000,
    });

    const targetProgress = await invoke<{
      progressPercent: number | null;
      pageNumber: number | null;
      cfi: string | null;
      locator: string | null;
    } | null>(page, "get_reading_progress", { bookId: target.id });
    expect(targetProgress?.progressPercent).toBe(37);
    expect(targetProgress?.pageNumber).toBeNull();
    expect(targetProgress?.cfi).toBeNull();
    expect(targetProgress?.locator).toBeNull();

    const sourceAnnotations = await invoke<unknown[]>(page, "list_annotations", {
      bookId: source.id,
    });
    expect(sourceAnnotations).toHaveLength(annotationsBefore);
    const targetAnnotations = await invoke<unknown[]>(page, "list_annotations", {
      bookId: target.id,
    });
    expect(targetAnnotations).toHaveLength(0);

    const editions = await invoke<Array<{ id: number; inLibrary: boolean }>>(
      page,
      "list_book_editions",
      { bookId: target.id },
    );
    expect(editions).toHaveLength(1);
    expect(editions[0]?.id).toBe(source.id);
    expect(editions[0]?.inLibrary).toBe(false);

    // Put the original back so later suites see the seeded library intact.
    await page.evaluate(async (path) => {
      await window.tuxbooks!.invoke("import_paths", { paths: [path] });
    }, source.path);
  });
});
