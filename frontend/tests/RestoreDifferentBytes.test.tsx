import { beforeEach, describe, expect, it } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RestoreBookDialog } from "@/components/books/RestoreBookDialog";
import { HistorySettings } from "@/components/settings/HistorySettings";
import { AppStateProvider } from "@/state/AppStateProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { makeBook, makeBookTrashEntry } from "./factories";
import { invokeMock, mockInvoke, pickBookFileMock } from "./mocks/bridge";

/** The report `restore_book` sends when the picked bytes match no snapshot hash. */
function differentBytesReport(differentBytes: Record<string, unknown> = {}) {
  return {
    status: "different_bytes",
    bookId: null,
    bookUid: null,
    replacedBookIds: [],
    conflict: null,
    differentBytes: {
      title: "Another Edition",
      author: "Ada Lovelace",
      progressPercent: 10,
      annotationCount: 4,
      collections: 2,
      hasMetadataOverrides: true,
      providerLinks: 1,
      ownerBookId: null,
      ...differentBytes,
    },
  };
}

function renderTree() {
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

function renderHistory(library: ReturnType<typeof makeBook>[] = []) {
  mockInvoke({
    get_library_stats: { bookCount: library.length, collectionCount: 0 },
    list_books: library,
    list_collections: [],
    list_reading_history: [],
    list_book_trash: [makeBookTrashEntry({ id: 7, replacementBookId: null })],
  });
  return renderTree();
}

/** forgotten tab → Restore → picker answers → the dialog is up. */
async function openDialog(
  report: Record<string, unknown>,
  library: ReturnType<typeof makeBook>[] = [],
) {
  renderHistory(library);
  mockInvoke({
    get_library_stats: { bookCount: library.length, collectionCount: 0 },
    list_books: library,
    list_collections: [],
    list_reading_history: [],
    list_book_trash: [makeBookTrashEntry({ id: 7, replacementBookId: null })],
    restore_book: report,
  });
  await userEvent.click(screen.getByTestId("history-tab-forgotten"));
  await screen.findByTestId("book-trash-restore-7");
  pickBookFileMock.mockResolvedValueOnce("/books/other.epub");
  await userEvent.click(screen.getByTestId("book-trash-restore-7"));
  return screen.findByTestId("restore-different-bytes-dialog");
}

/** forgotten tab → Restore → picker answers, with invoke routed by hand. */
async function openDialogWithSequence(onRestore: (call: number) => unknown) {
  let trashLoads = 0;
  let restores = 0;
  invokeMock.mockImplementation((method: string) => {
    if (method === "list_reading_history") return Promise.resolve([]);
    if (method === "get_library_stats") {
      return Promise.resolve({ bookCount: 0, collectionCount: 0 });
    }
    if (method === "list_books") return Promise.resolve([]);
    if (method === "list_collections") return Promise.resolve([]);
    if (method === "list_book_trash") {
      trashLoads += 1;
      return Promise.resolve(
        trashLoads === 1 ? [makeBookTrashEntry({ id: 7, replacementBookId: null })] : [],
      );
    }
    if (method === "restore_book") {
      restores += 1;
      return Promise.resolve(onRestore(restores));
    }
    return Promise.reject(new Error(`unexpected invoke(${method}) in test`));
  });
  renderTree();
  await userEvent.click(screen.getByTestId("history-tab-forgotten"));
  await screen.findByTestId("book-trash-restore-7");
  pickBookFileMock.mockResolvedValueOnce("/books/other.epub");
  await userEvent.click(screen.getByTestId("book-trash-restore-7"));
  await screen.findByTestId("restore-different-bytes-dialog");
}

const restored = {
  status: "restored",
  bookId: 77,
  bookUid: "0123456789abcdef0123456789abcdef",
  replacedBookIds: [],
  conflict: null,
  differentBytes: null,
};

beforeEach(() => {
  invokeMock.mockClear();
  pickBookFileMock.mockReset();
  pickBookFileMock.mockResolvedValue(null);
});

describe("RestoreDifferentBytes dialog", () => {
  it("shows the forgotten book, its snapshot state, and the annotation promise", async () => {
    const dialog = await openDialog(differentBytesReport());

    expect(dialog).toHaveTextContent("Another Edition");
    expect(dialog).toHaveTextContent("Ada Lovelace");
    expect(dialog).toHaveTextContent("10% reading progress");
    expect(dialog).toHaveTextContent("4 annotations");
    expect(dialog).toHaveTextContent("2 collection memberships");
    expect(dialog).toHaveTextContent("metadata edits");
    expect(dialog).toHaveTextContent("1 provider link");
    expect(dialog).toHaveTextContent("Annotations stay with the restored record");
    // Nothing was consumed: the trash entry stays and no refresh ran.
    expect(screen.getByTestId("book-trash-restore-7")).toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([method]) => method === "list_book_trash")).toHaveLength(
      1,
    );
  });

  it("offers Link as an edition and names the library entry that owns the pick", async () => {
    const dialog = await openDialog(differentBytesReport({ ownerBookId: 12 }), [
      makeBook({ id: 12, title: "Owner Edition" }),
    ]);

    expect(dialog).toHaveTextContent("Owner Edition");
    expect(screen.getByTestId("restore-different-bytes-link")).toBeInTheDocument();
    expect(screen.getByTestId("restore-different-bytes-without-file")).toBeInTheDocument();
  });

  it("keeps Link as an edition off the table when no entry owns the pick", async () => {
    await openDialog(differentBytesReport());

    expect(screen.queryByTestId("restore-different-bytes-link")).not.toBeInTheDocument();
    expect(screen.getByTestId("restore-different-bytes-without-file")).toBeInTheDocument();
  });

  it("Restore without file detaches the record with the kept picked path", async () => {
    await openDialogWithSequence((call) => (call === 1 ? differentBytesReport() : restored));

    await userEvent.click(screen.getByTestId("restore-different-bytes-without-file"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("restore_book", {
        trashId: 7,
        mode: "without_file",
        pickedPath: "/books/other.epub",
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("restore-different-bytes-dialog")).not.toBeInTheDocument();
    });
    // The record left the trash and the list reloaded.
    expect(screen.queryByTestId("book-trash-restore-7")).not.toBeInTheDocument();
  });

  it("Link as an edition calls link_edition with the kept picked path", async () => {
    let trashLoads = 0;
    let restores = 0;
    invokeMock.mockImplementation((method: string) => {
      if (method === "list_reading_history") return Promise.resolve([]);
      if (method === "get_library_stats") {
        return Promise.resolve({ bookCount: 1, collectionCount: 0 });
      }
      if (method === "list_books") {
        return Promise.resolve([makeBook({ id: 12, title: "Owner Edition" })]);
      }
      if (method === "list_collections") return Promise.resolve([]);
      if (method === "list_book_trash") {
        trashLoads += 1;
        return Promise.resolve(
          trashLoads === 1 ? [makeBookTrashEntry({ id: 7, replacementBookId: null })] : [],
        );
      }
      if (method === "restore_book") {
        restores += 1;
        return Promise.resolve(
          restores === 1 ? differentBytesReport({ ownerBookId: 12 }) : restored,
        );
      }
      return Promise.reject(new Error(`unexpected invoke(${method}) in test`));
    });
    renderTree();
    await userEvent.click(screen.getByTestId("history-tab-forgotten"));
    await screen.findByTestId("book-trash-restore-7");
    pickBookFileMock.mockResolvedValueOnce("/books/other.epub");
    await userEvent.click(screen.getByTestId("book-trash-restore-7"));
    await screen.findByTestId("restore-different-bytes-dialog");

    await userEvent.click(screen.getByTestId("restore-different-bytes-link"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("restore_book", {
        trashId: 7,
        mode: "link_edition",
        pickedPath: "/books/other.epub",
      });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("restore-different-bytes-dialog")).not.toBeInTheDocument();
    });
  });

  it("Cancel closes the dialog and leaves the trash entry untouched", async () => {
    await openDialog(differentBytesReport());

    await userEvent.click(screen.getByTestId("restore-different-bytes-cancel"));

    await waitFor(() => {
      expect(screen.queryByTestId("restore-different-bytes-dialog")).not.toBeInTheDocument();
    });
    expect(screen.getByTestId("book-trash-restore-7")).toBeInTheDocument();
    expect(invokeMock.mock.calls.filter(([method]) => method === "restore_book")).toHaveLength(1);
  });

  it("names all six kinds the restore conflict would touch", () => {
    render(
      <RestoreBookDialog
        open
        entry={makeBookTrashEntry({ id: 7, title: "Old Copy" })}
        conflict={{
          progressPercent: 55,
          annotationCount: 2,
          collections: 3,
          hasMetadataOverrides: true,
          providerLinks: 1,
          editionLinks: 2,
        }}
        onChoose={() => {}}
        onCancel={() => {}}
      />,
    );

    const dialog = screen.getByTestId("restore-book-dialog");
    expect(dialog).toHaveTextContent("55% progress");
    expect(dialog).toHaveTextContent("2 annotations");
    expect(dialog).toHaveTextContent("3 collection memberships");
    expect(dialog).toHaveTextContent("metadata edits");
    expect(dialog).toHaveTextContent("1 provider link");
    expect(dialog).toHaveTextContent("2 edition links");
  });
});
