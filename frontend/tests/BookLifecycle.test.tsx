import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ForgetBookDialog } from "@/components/books/ForgetBookDialog";
import { EraseBookDialog } from "@/components/books/EraseBookDialog";
import { ResetBookDialog } from "@/components/books/ResetBookDialog";
import { RestoreBookDialog } from "@/components/books/RestoreBookDialog";
import { HistorySettings } from "@/components/settings/HistorySettings";
import { AppStateProvider } from "@/state/AppStateProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { makeBook, makeBookTrashEntry, makeReadingHistoryBook } from "./factories";
import { invokeMock, mockInvoke, pickBookFileMock } from "./mocks/bridge";

function baseResponses(
  history = [makeReadingHistoryBook({ id: 41 })],
  trash = [] as ReturnType<typeof makeBookTrashEntry>[],
) {
  return {
    get_library_stats: { bookCount: 0, collectionCount: 0 },
    list_books: [] as ReturnType<typeof makeBook>[],
    list_collections: [],
    list_reading_history: history,
    list_book_trash: trash,
  };
}

function renderHistory() {
  return render(
    <AppStateProvider>
      <LibraryDataProvider>
        <ImportProvider>
          <HistorySettings />
        </ImportProvider>
      </LibraryDataProvider>
    </AppStateProvider>,
  );
}

/** The forgotten list lives on its own tab; switching is part of the flow. */
async function openForgottenTab(trashId: number) {
  await userEvent.click(screen.getByTestId("history-tab-forgotten"));
  await screen.findByTestId(`book-trash-restore-${trashId}`);
}

beforeEach(() => {
  invokeMock.mockClear();
});

describe("Reset and Forget dialogs", () => {
  it("Reset names every cleared surface and promises the book and file stay", () => {
    render(<ResetBookDialog open title="Dune" onConfirm={() => {}} onCancel={() => {}} />);

    const dialog = screen.getByTestId("reset-book-dialog");
    expect(dialog).toHaveTextContent("reading progress");
    expect(dialog).toHaveTextContent("annotations");
    expect(dialog).toHaveTextContent("collection membership");
    expect(dialog).toHaveTextContent("metadata overrides");
    expect(dialog).toHaveTextContent("provider links");
    expect(dialog).toHaveTextContent("keeps its identity");
    expect(dialog).toHaveTextContent("current file");
    expect(dialog).toHaveTextContent("cannot be undone");
  });

  it("Forget says what leaves, what stays, and the 30-day restore window", () => {
    render(<ForgetBookDialog open count={1} keepsFile onConfirm={() => {}} onCancel={() => {}} />);

    const dialog = screen.getByTestId("forget-book-dialog");
    expect(dialog).toHaveTextContent("erases this book's identity");
    expect(dialog).toHaveTextContent("reading progress");
    expect(dialog).toHaveTextContent("library entry stay");
    expect(dialog).toHaveTextContent("30 days");
    expect(dialog).toHaveTextContent("Replace, Keep, or Merge");
    expect(dialog).toHaveTextContent("remote provider history is not deleted");
  });

  it("Erase names every deleted surface and says the file stays", () => {
    render(<EraseBookDialog open title="Old Copy" onConfirm={() => {}} onCancel={() => {}} />);

    const dialog = screen.getByTestId("erase-book-dialog");
    expect(dialog).toHaveTextContent("Old Copy");
    expect(dialog).toHaveTextContent("reading progress");
    expect(dialog).toHaveTextContent("annotations");
    expect(dialog).toHaveTextContent("collection membership");
    expect(dialog).toHaveTextContent("metadata overrides");
    expect(dialog).toHaveTextContent("provider links");
    expect(dialog).toHaveTextContent("files on disk are not touched");
    expect(dialog).toHaveTextContent("cannot be undone");
  });

  it("bulk Forget names the count and keeps files on disk", () => {
    render(
      <ForgetBookDialog
        open
        count={3}
        keepsFile={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    const dialog = screen.getByTestId("forget-book-dialog");
    expect(dialog).toHaveTextContent("Forget 3 books?");
    expect(dialog).toHaveTextContent("Your files on disk are not touched");
  });

  it("Reset and Forget confirm and cancel through their buttons", async () => {
    const resetConfirm = vi.fn();
    const resetCancel = vi.fn();
    const { unmount } = render(
      <ResetBookDialog open onConfirm={resetConfirm} onCancel={resetCancel} />,
    );
    await userEvent.click(screen.getByTestId("reset-book-confirm"));
    expect(resetConfirm).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByTestId("reset-book-cancel"));
    expect(resetCancel).toHaveBeenCalledOnce();
    unmount();

    const forgetConfirm = vi.fn();
    const forgetCancel = vi.fn();
    render(
      <ForgetBookDialog
        open
        count={1}
        keepsFile
        onConfirm={forgetConfirm}
        onCancel={forgetCancel}
      />,
    );
    expect(screen.getByTestId("forget-book-dialog")).toHaveTextContent(
      "The file and the library entry stay",
    );
    await userEvent.click(screen.getByTestId("forget-book-confirm"));
    expect(forgetConfirm).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByTestId("forget-book-cancel"));
    expect(forgetCancel).toHaveBeenCalledOnce();
  });

  it("Restore offers all three choices and reports the selected mode", async () => {
    const choose = vi.fn();
    const cancel = vi.fn();
    const entry = makeBookTrashEntry({ title: "Old Copy" });
    const { rerender } = render(
      <RestoreBookDialog
        open
        entry={entry}
        conflict={{
          progressPercent: null,
          annotationCount: 1,
          collections: 0,
          hasMetadataOverrides: false,
          providerLinks: 0,
          editionLinks: 0,
        }}
        onChoose={choose}
        onCancel={cancel}
      />,
    );
    expect(screen.getByTestId("restore-book-dialog")).toHaveTextContent("1 annotation");
    await userEvent.click(screen.getByTestId("restore-book-replace"));
    await userEvent.click(screen.getByTestId("restore-book-keep"));
    await userEvent.click(screen.getByTestId("restore-book-merge"));
    expect(choose.mock.calls).toEqual([["replace"], ["keep"], ["merge"]]);
    await userEvent.click(screen.getByTestId("restore-book-cancel"));
    expect(cancel).toHaveBeenCalledOnce();

    rerender(
      <RestoreBookDialog
        open
        entry={null}
        conflict={null}
        busy
        onChoose={choose}
        onCancel={cancel}
      />,
    );
    const dialog = screen.getByTestId("restore-book-dialog");
    expect(dialog).toHaveTextContent("Restore this book?");
    expect(dialog).toHaveTextContent("current copy already has new reading data.");
    expect(screen.getByTestId("restore-book-merge")).toBeDisabled();
  });
});

describe("History Forget and restore", () => {
  it("selects all detached records and forgets them in one dialog", async () => {
    mockInvoke({
      ...baseResponses([
        makeReadingHistoryBook({ id: 41, title: "First" }),
        makeReadingHistoryBook({ id: 42, title: "Second" }),
      ]),
      forget_books: { forgotten: 2, trashIds: [8, 9] },
    });
    renderHistory();

    await screen.findAllByTestId("history-book");
    await userEvent.click(screen.getByTestId("history-select-all"));
    expect(screen.getByTestId("history-forget-selected")).toHaveTextContent("Forget selected (2)…");
    await userEvent.click(screen.getByTestId("history-forget-selected"));
    expect(screen.getByTestId("forget-book-dialog")).toHaveTextContent("Forget 2 books?");
    await userEvent.click(screen.getByTestId("forget-book-confirm"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("forget_books", { bookIds: [41, 42] });
    });
  });

  it("resets one detached record through the shared Reset dialog", async () => {
    mockInvoke({
      ...baseResponses([makeReadingHistoryBook({ id: 41, title: "Keep Me" })]),
      reset_book_reading_data: true,
    });
    renderHistory();

    await screen.findByTestId("history-book");
    await userEvent.click(screen.getByTestId("history-reset-41"));
    expect(screen.getByTestId("reset-book-dialog")).toHaveTextContent("Keep Me");
    await userEvent.click(screen.getByTestId("reset-book-confirm"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("reset_book_reading_data", { bookId: 41 });
    });
  });

  it("restores silently when the current book has no new state", async () => {
    mockInvoke({
      ...baseResponses([], [makeBookTrashEntry({ id: 7, title: "Old Copy", hasNewState: false })]),
      restore_book: {
        status: "restored",
        bookId: 41,
        bookUid: "abcdefabcdefabcdefabcdefabcdefab",
        conflict: null,
      },
    });
    renderHistory();

    await screen.findByTestId("history-tab-forgotten");
    await openForgottenTab(7);
    await userEvent.click(screen.getByTestId("book-trash-restore-7"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("restore_book", { trashId: 7 });
    });
    expect(screen.queryByTestId("restore-book-dialog")).not.toBeInTheDocument();
  });

  it("erases a forgotten row only after the confirm dialog", async () => {
    mockInvoke({
      ...baseResponses(
        [],
        [makeBookTrashEntry({ id: 7, title: "Old Copy", replacementBookId: null })],
      ),
      erase_book_trash: true,
    });
    renderHistory();

    await openForgottenTab(7);
    await userEvent.click(screen.getByTestId("book-trash-erase-7"));

    const dialog = screen.getByTestId("erase-book-dialog");
    expect(dialog).toHaveTextContent("Old Copy");
    expect(invokeMock).not.toHaveBeenCalledWith("erase_book_trash", { trashId: 7 });

    await userEvent.click(screen.getByTestId("erase-book-confirm"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("erase_book_trash", { trashId: 7 });
    });
  });

  it("keeps the entry when Erase is cancelled", async () => {
    mockInvoke({
      ...baseResponses([], [makeBookTrashEntry({ id: 7, replacementBookId: null })]),
      erase_book_trash: true,
    });
    renderHistory();

    await openForgottenTab(7);
    await userEvent.click(screen.getByTestId("book-trash-erase-7"));
    await userEvent.click(screen.getByTestId("erase-book-cancel"));

    expect(invokeMock).not.toHaveBeenCalledWith("erase_book_trash", { trashId: 7 });
  });

  it("asks for the file and restores the picked path in one step", async () => {
    pickBookFileMock.mockResolvedValueOnce("/books/old-copy.epub");
    mockInvoke({
      ...baseResponses(
        [],
        [makeBookTrashEntry({ id: 7, replacementBookId: null, lastKnownPath: "/books" })],
      ),
      restore_book: {
        status: "restored",
        bookId: 41,
        bookUid: "abcdefabcdefabcdefabcdefabcdefab",
        conflict: null,
      },
    });
    renderHistory();

    await openForgottenTab(7);
    await userEvent.click(screen.getByTestId("book-trash-restore-7"));

    await waitFor(() => {
      expect(pickBookFileMock).toHaveBeenCalledWith(7);
    });
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("restore_book", {
        trashId: 7,
        pickedPath: "/books/old-copy.epub",
      });
    });
    await waitFor(() => {
      expect(invokeMock.mock.calls.filter(([method]) => method === "list_book_trash")).toHaveLength(
        2,
      );
    });
    expect(screen.queryByTestId("restore-book-dialog")).not.toBeInTheDocument();
  });

  it("leaves the trash entry untouched when the picker is cancelled", async () => {
    mockInvoke({
      ...baseResponses([], [makeBookTrashEntry({ id: 7, replacementBookId: null })]),
    });
    renderHistory();

    await openForgottenTab(7);
    await userEvent.click(screen.getByTestId("book-trash-restore-7"));

    await waitFor(() => {
      expect(pickBookFileMock).toHaveBeenCalledWith(7);
    });
    expect(invokeMock).not.toHaveBeenCalledWith("restore_book", expect.anything());
    expect(screen.getByTestId("book-trash-restore-7")).toBeInTheDocument();
    expect(screen.queryByTestId("history-error")).not.toBeInTheDocument();
  });

  it("carries the picked path through the conflict choice", async () => {
    let restores = 0;
    invokeMock.mockImplementation((method: string) => {
      if (method === "list_reading_history") return Promise.resolve([]);
      if (method === "list_book_trash") {
        return Promise.resolve([makeBookTrashEntry({ id: 7, replacementBookId: null })]);
      }
      if (method === "get_library_stats") {
        return Promise.resolve({ bookCount: 0, collectionCount: 0 });
      }
      if (method === "list_books") return Promise.resolve([]);
      if (method === "list_collections") return Promise.resolve([]);
      if (method === "restore_book") {
        restores += 1;
        if (restores === 1) {
          return Promise.resolve({
            status: "conflict",
            bookId: 51,
            bookUid: "fresh",
            conflict: { progressPercent: 55, annotationCount: 2 },
          });
        }
        return Promise.resolve({
          status: "restored",
          bookId: 51,
          bookUid: "fresh",
          conflict: null,
        });
      }
      return Promise.reject(new Error(`unexpected invoke(${method}) in test`));
    });
    pickBookFileMock.mockResolvedValueOnce("/books/old-copy.epub");
    renderHistory();

    await openForgottenTab(7);
    await userEvent.click(screen.getByTestId("book-trash-restore-7"));
    await screen.findByTestId("restore-book-dialog");
    await userEvent.click(screen.getByTestId("restore-book-merge"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("restore_book", {
        trashId: 7,
        mode: "merge",
        pickedPath: "/books/old-copy.epub",
      });
    });
  });

  it("surfaces a failed pick in the error box and keeps the entry open", async () => {
    pickBookFileMock.mockResolvedValueOnce("/books/other.epub");
    mockInvoke({
      ...baseResponses([], [makeBookTrashEntry({ id: 7, replacementBookId: null })]),
      restore_book: new Error("no file exists at /books/other.epub"),
    });
    renderHistory();

    await openForgottenTab(7);
    await userEvent.click(screen.getByTestId("book-trash-restore-7"));

    await waitFor(() => {
      expect(pickBookFileMock).toHaveBeenCalledWith(7);
    });
    const error = await screen.findByTestId("history-error");
    expect(error).toHaveTextContent("no file exists at /books/other.epub");
    expect(screen.getByTestId("book-trash-restore-7")).toBeInTheDocument();
    expect(screen.queryByTestId("restore-book-dialog")).not.toBeInTheDocument();
  });

  it("opens the lossless-choices dialog on a different-bytes report", async () => {
    pickBookFileMock.mockResolvedValueOnce("/books/other.epub");
    mockInvoke({
      ...baseResponses([], [makeBookTrashEntry({ id: 7, replacementBookId: null })]),
      restore_book: {
        status: "different_bytes",
        bookId: null,
        bookUid: null,
        replacedBookIds: [],
        conflict: null,
        differentBytes: {
          title: "Another Edition",
          author: null,
          progressPercent: 10,
          annotationCount: 1,
          collections: 0,
          hasMetadataOverrides: false,
          providerLinks: 0,
          ownerBookId: null,
        },
      },
    });
    renderHistory();

    await openForgottenTab(7);
    await userEvent.click(screen.getByTestId("book-trash-restore-7"));

    const dialog = await screen.findByTestId("restore-different-bytes-dialog");
    expect(dialog).toHaveTextContent("not the one");
    expect(screen.getByTestId("book-trash-restore-7")).toBeInTheDocument();
    expect(screen.queryByTestId("restore-book-dialog")).not.toBeInTheDocument();
    // Nothing was consumed: no refresh ran after the report.
    expect(invokeMock.mock.calls.filter(([method]) => method === "list_book_trash")).toHaveLength(
      1,
    );
  });

  it("offers Replace, Keep, or Merge when the current book has new state", async () => {
    let restores = 0;
    invokeMock.mockImplementation((method: string, params: Record<string, unknown>) => {
      if (method === "list_reading_history") return Promise.resolve([]);
      if (method === "list_book_trash") {
        return Promise.resolve([
          makeBookTrashEntry({ id: 7, title: "Old Copy", hasNewState: true }),
        ]);
      }
      if (method === "get_library_stats") {
        return Promise.resolve({ bookCount: 0, collectionCount: 0 });
      }
      if (method === "list_books") return Promise.resolve([]);
      if (method === "list_collections") return Promise.resolve([]);
      if (method === "restore_book") {
        restores += 1;
        if (restores === 1) {
          return Promise.resolve({
            status: "conflict",
            bookId: 51,
            bookUid: "fresh",
            conflict: { progressPercent: 55, annotationCount: 2 },
          });
        }
        return Promise.resolve({
          status: "restored",
          bookId: 51,
          bookUid: "fresh",
          conflict: null,
        });
      }
      return Promise.reject(new Error(`unexpected invoke(${method}) in test: ${params}`));
    });
    renderHistory();

    await screen.findByTestId("history-tab-forgotten");
    await openForgottenTab(7);
    await userEvent.click(screen.getByTestId("book-trash-restore-7"));

    const dialog = await screen.findByTestId("restore-book-dialog");
    expect(dialog).toHaveTextContent("55% progress");
    expect(dialog).toHaveTextContent("2 annotations");
    expect(screen.getByTestId("restore-book-replace")).toBeInTheDocument();
    expect(screen.getByTestId("restore-book-keep")).toBeInTheDocument();
    expect(screen.getByTestId("restore-book-merge")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("restore-book-merge"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("restore_book", { trashId: 7, mode: "merge" });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("restore-book-dialog")).not.toBeInTheDocument();
    });
  });
});
