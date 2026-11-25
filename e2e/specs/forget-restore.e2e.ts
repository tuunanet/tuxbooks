import { expect, test, type ElectronApplication, type Page } from "../fixtures/electron-app.js";

import { seededBookTitles } from "../setup/fixtures.js";
import { ensureLibrary, closeSettings, openHistory, waitForLibraryView } from "./helpers.js";

/**
 * Forget and restore (ADR 0014 D5, ticket tuxbooks-ip6.7): Forget moves the
 * old identity to the 30-day trash and keeps the library entry under a fresh
 * identity. Reading the fresh book and then restoring offers the deliberate
 * Replace / Keep / Merge choice; Merge keeps the newer progress and both
 * annotations. The restore-with-a-file journeys (tuxbooks-t9p.6) run after
 * that test: they re-seed from the library and depend on an empty trash, and
 * the last one deliberately leaves the EPUB detached.
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

interface ForgetSeed {
  path: string;
  trashId: number;
  annotationsBefore: number;
}

/** Wait out the forget event storm, then return the entry this journey seeded. */
async function seededTrashEntry(page: Page, title: string): Promise<{ id: number }> {
  await expect
    .poll(async () => {
      const trash = await invoke<Array<{ id: number; title: string | null }>>(
        page,
        "list_book_trash",
        {},
      );
      return trash.some((entry) => entry.title === title);
    })
    .toBe(true);
  const trash = await invoke<Array<{ id: number; title: string | null }>>(
    page,
    "list_book_trash",
    {},
  );
  const entry = trash.find((candidate) => candidate.title === title);
  if (!entry) throw new Error("the seeded trash entry vanished");
  return entry;
}

/**
 * Detach the seeded EPUB and forget the record: Remove writes the last known
 * path, the Forget seeds one no-file trash entry whose file is still on disk.
 * Entirely dialog-free.
 */
async function seedForgottenEntry(page: Page): Promise<ForgetSeed> {
  const books = await invoke<LibraryBook[]>(page, "list_books", {});
  const book = books.find((candidate) => candidate.title === seededBookTitles.epub);
  if (!book) throw new Error("the seeded EPUB is not in the library");
  const annotationsBefore = (await invoke<unknown[]>(page, "list_annotations", { bookId: book.id }))
    .length;
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
        text: "forgotten journey bookmark",
      },
    });
    await window.tuxbooks!.invoke("remove_book", { bookId });
    await window.tuxbooks!.invoke("forget_book", { bookId });
  }, book.id);
  return {
    path: book.path,
    trashId: (await seededTrashEntry(page, seededBookTitles.epub)).id,
    annotationsBefore,
  };
}

/**
 * Answer the book-file picker without a native dialog: main's showOpenDialog
 * hands back `picked`, so the result crosses the real dialog channel and the
 * path is issued for real (the restore's IPC check accepts it).
 */
async function stubBookFileDialog(electronApp: ElectronApplication, picked: string): Promise<void> {
  await electronApp.evaluate(({ dialog }, filePath) => {
    const patchable = dialog as unknown as {
      showOpenDialog: (options: unknown) => Promise<{ canceled: boolean; filePaths: string[] }>;
    };
    (globalThis as { __tuxbooksE2EOpenDialog?: unknown }).__tuxbooksE2EOpenDialog =
      patchable.showOpenDialog;
    patchable.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, picked);
}

/** Undo the picker stub so the shared app keeps its native dialogs. */
async function restoreBookFileDialog(electronApp: ElectronApplication): Promise<void> {
  await electronApp
    .evaluate(({ dialog }) => {
      const original = (globalThis as { __tuxbooksE2EOpenDialog?: unknown })
        .__tuxbooksE2EOpenDialog;
      if (typeof original === "function") {
        (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = original;
      }
    })
    .catch(() => {});
}

test.describe("forget and restore", () => {
  test("forget keeps the library entry and restore merges the old record", async ({ page }) => {
    await ensureLibrary(page);
    const books = await invoke<LibraryBook[]>(page, "list_books", {});
    const book = books.find((candidate) => candidate.title === seededBookTitles.epub);
    if (!book) throw new Error("the seeded EPUB is not in the library");
    const annotationsBefore = (
      await invoke<unknown[]>(page, "list_annotations", { bookId: book.id })
    ).length;

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

    await openHistory(page);
    await page.getByTestId("history-tab-forgotten").click();
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

    await expect(page.getByTestId("book-trash-entry")).toHaveCount(0, { timeout: 30000 });
    await closeSettings(page);
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
    // The seeded library and earlier specs may already own annotations; Merge
    // adds this journey's old bookmark and fresh highlight to whatever was
    // there before the forget.
    expect(annotations).toHaveLength(annotationsBefore + 2);

    // Merge consumed the trash entry, so the next spec starts clean.
    const trash = await invoke<BookTrashEntry[]>(page, "list_book_trash", {});
    expect(trash).toHaveLength(0);
  });

  test("Restore on a no-file row asks for the file and returns it in one step", async ({
    page,
    electronApp,
  }) => {
    await ensureLibrary(page);
    const seed = await seedForgottenEntry(page);
    await openHistory(page);
    await page.getByTestId("history-tab-forgotten").click();
    const row = page.getByTestId("book-trash-entry").filter({ hasText: seededBookTitles.epub });
    await expect(row).toHaveCount(1, { timeout: 30000 });
    await expect(row.getByTestId("book-trash-file-state")).toContainText(
      "No file. Restore will ask you to choose one.",
    );
    await expect(row.getByTestId("book-trash-was-at")).toContainText(`Was at ${seed.path}`);
    await expect(row.getByTestId(`book-trash-restore-without-file-${seed.trashId}`)).toBeVisible();

    await stubBookFileDialog(electronApp, seed.path);
    try {
      await row.getByTestId(`book-trash-restore-${seed.trashId}`).click();
      // The refresh carries the book in and the entry out.
      await expect(row).toHaveCount(0, { timeout: 30000 });
    } finally {
      await restoreBookFileDialog(electronApp);
    }

    await closeSettings(page);
    await page.getByRole("button", { name: "All Books" }).click();
    await waitForLibraryView(page);
    await expect(page.locator(`[aria-label="${seededBookTitles.epub} (EPUB)"]`)).toHaveCount(1);
    const restored = (await invoke<LibraryBook[]>(page, "list_books", {})).find(
      (candidate) => candidate.path === seed.path,
    );
    if (!restored) throw new Error("the restored book never came back to the library");
    const progress = await invoke<{ progressPercent: number | null } | null>(
      page,
      "get_reading_progress",
      { bookId: restored.id },
    );
    expect(progress?.progressPercent).toBe(13);
    const annotations = await invoke<unknown[]>(page, "list_annotations", {
      bookId: restored.id,
    });
    expect(annotations).toHaveLength(seed.annotationsBefore + 1);
  });

  test("Restore without file returns the record to Detached records", async ({ page }) => {
    await ensureLibrary(page);
    const seed = await seedForgottenEntry(page);
    await openHistory(page);
    await page.getByTestId("history-tab-forgotten").click();
    const row = page.getByTestId("book-trash-entry").filter({ hasText: seededBookTitles.epub });
    await expect(row).toHaveCount(1, { timeout: 30000 });

    await row.getByTestId(`book-trash-restore-without-file-${seed.trashId}`).click();

    await expect(row).toHaveCount(0, { timeout: 30000 });
    const detached = page.getByTestId("history-book").filter({ hasText: seededBookTitles.epub });
    await expect(detached).toHaveCount(1, { timeout: 30000 });
    const inLibrary = (await invoke<LibraryBook[]>(page, "list_books", {})).some(
      (candidate) => candidate.path === seed.path,
    );
    expect(inLibrary).toBe(false);
  });
});
