import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ForgetBookDialog } from "@/components/books/ForgetBookDialog";
import { ResetBookDialog } from "@/components/books/ResetBookDialog";
import { RestoreBookDialog } from "@/components/books/RestoreBookDialog";
import { ReadingHistoryView } from "@/components/history/ReadingHistoryView";
import { AppStateProvider } from "@/state/AppStateProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { makeBook, makeBookTrashEntry, makeReadingHistoryBook } from "./factories";
import { invokeMock, mockInvoke } from "./mocks/bridge";

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
          <ReadingHistoryView />
        </ImportProvider>
      </LibraryDataProvider>
    </AppStateProvider>,
  );
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
        conflict={{ progressPercent: null, annotationCount: 1 }}
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

describe("Reading history Forget and restore", () => {
  it("selects all history books and forgets them in one dialog", async () => {
    mockInvoke({
      ...baseResponses([
        makeReadingHistoryBook({ id: 41, title: "First" }),
        makeReadingHistoryBook({ id: 42, title: "Second" }),
      ]),
      forget_books: { forgotten: 2, trashIds: [8, 9] },
    });
    renderHistory();

    await screen.findAllByTestId("reading-history-book");
    await userEvent.click(screen.getByTestId("reading-history-select-all"));
    expect(screen.getByTestId("reading-history-forget-selected")).toHaveTextContent(
      "Forget selected (2)",
    );
    await userEvent.click(screen.getByTestId("reading-history-forget-selected"));
    expect(screen.getByTestId("forget-book-dialog")).toHaveTextContent("Forget 2 books?");
    await userEvent.click(screen.getByTestId("forget-book-confirm"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("forget_books", { bookIds: [41, 42] });
    });
  });

  it("resets one history book through the shared Reset dialog", async () => {
    mockInvoke({
      ...baseResponses([makeReadingHistoryBook({ id: 41, title: "Keep Me" })]),
      reset_book_reading_data: true,
    });
    renderHistory();

    await screen.findByTestId("reading-history-book");
    await userEvent.click(screen.getByTestId("reading-history-reset-41"));
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

    await screen.findByTestId("recently-forgotten");
    await userEvent.click(screen.getByTestId("book-trash-restore-7"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("restore_book", { trashId: 7 });
    });
    expect(screen.queryByTestId("restore-book-dialog")).not.toBeInTheDocument();
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

    await screen.findByTestId("recently-forgotten");
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
