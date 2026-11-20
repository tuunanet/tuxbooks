import { describe, expect, it } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BookDetail } from "@/components/books/BookDetail";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { makeBook, makeBookFile } from "./factories";
import { invokeMock, mockInvoke, pickBookFileMock } from "./mocks/bridge";
import type { Book, LocateConflict } from "@/types/domain";

function renderDetail(bookId: number, books: Book[], extra: Record<string, unknown> = {}) {
  mockInvoke({
    get_library_stats: { bookCount: books.length, collectionCount: 0 },
    list_books: books,
    list_book_files: [makeBookFile()],
    list_collections: [],
    reconnect_book: new Error("invalid input: that file is already in the library"),
    ...extra,
  });
  return render(
    <AppStateProvider
      initialState={{
        view: "detail",
        section: { kind: "smart", id: "all-books" },
        selectedBookId: bookId,
        libraryQuery: "",
      }}
    >
      <LibraryDataProvider>
        <BookDetail />
      </LibraryDataProvider>
    </AppStateProvider>,
  );
}

function conflictFixture(): { candidate: Book; owner: Book; conflict: LocateConflict } {
  const candidate = makeBook({ id: 3, title: "Old copy", available: false });
  const owner = makeBook({ id: 4, title: "Machine Learning", path: "/library/present.epub" });
  return {
    candidate,
    owner,
    conflict: {
      owner,
      candidate,
      candidateState: {
        annotations: 3,
        hasProgress: true,
        progressPercent: 40,
        collections: 1,
        hasMetadataOverrides: false,
        providerLinks: 0,
        editionLinks: 0,
      },
    },
  };
}

describe("BookDetail Locate File", () => {
  it("shows why a picked file was rejected instead of failing silently", async () => {
    pickBookFileMock.mockResolvedValue("/library/already-there.epub");
    renderDetail(1, [makeBook({ available: false })], {
      locate_book: new Error("invalid input: that file is already in the library"),
    });

    await userEvent.click(await screen.findByTestId("detail-locate"));

    const error = await screen.findByTestId("detail-locate-error");
    expect(error).toHaveTextContent("that file is already in the library");
    expect(error).not.toHaveTextContent("invalid input");
  });

  it("opens the entry that owns the file when the user asks", async () => {
    pickBookFileMock.mockResolvedValue("/library/present.epub");
    const { candidate, owner, conflict } = conflictFixture();
    renderDetail(3, [candidate, owner], { locate_book: { kind: "conflict", conflict } });

    await userEvent.click(await screen.findByTestId("detail-locate"));
    const dialog = await screen.findByTestId("locate-conflict-dialog");
    expect(dialog).toHaveTextContent("Machine Learning");
    expect(dialog).toHaveTextContent("3 highlights and bookmarks");

    await userEvent.click(screen.getByTestId("locate-conflict-open"));
    expect(await screen.findByTestId("detail-title")).toHaveTextContent("Machine Learning");
  });

  it("moves the stale entry to Reading history without deleting state", async () => {
    pickBookFileMock.mockResolvedValue("/library/present.epub");
    const { candidate, owner, conflict } = conflictFixture();
    renderDetail(3, [candidate, owner], {
      locate_book: { kind: "conflict", conflict },
      remove_book: true,
    });

    await userEvent.click(await screen.findByTestId("detail-locate"));
    await userEvent.click(await screen.findByTestId("locate-conflict-history"));

    expect(invokeMock).toHaveBeenCalledWith("remove_book", { bookId: 3 });
    expect(await screen.findByTestId("detail-title")).toHaveTextContent("Machine Learning");
  });

  it("switches to the surviving entry after a lossless merge", async () => {
    pickBookFileMock.mockResolvedValue("/library/present.epub");
    const { candidate, owner } = conflictFixture();
    renderDetail(3, [candidate, owner], {
      locate_book: {
        kind: "merged",
        book: owner,
        mergedFrom: { id: 3, title: "Old copy" },
      },
    });

    await userEvent.click(await screen.findByTestId("detail-locate"));

    expect(await screen.findByTestId("detail-title")).toHaveTextContent("Machine Learning");
  });

  it("opens the surviving entry after detaching an empty duplicate", async () => {
    pickBookFileMock.mockResolvedValue("/library/present.epub");
    const { candidate, owner } = conflictFixture();
    renderDetail(3, [candidate, owner], {
      locate_book: {
        kind: "detached",
        book: owner,
        detachedFrom: { id: 3, title: "Old copy" },
      },
    });

    await userEvent.click(await screen.findByTestId("detail-locate"));

    expect(await screen.findByTestId("detail-title")).toHaveTextContent("Machine Learning");
  });

  it("links as an edition without overwriting the readable copy's progress", async () => {
    pickBookFileMock.mockResolvedValue("/library/present.epub");
    const { candidate, owner, conflict } = conflictFixture();
    renderDetail(3, [candidate, owner], {
      locate_book: { kind: "conflict", conflict },
      link_book_edition: {
        sourceBookId: 3,
        targetBookId: 4,
        sourceBookUid: "a".repeat(32),
        targetBookUid: "b".repeat(32),
        copiedProgressPercent: null,
        movedProviders: [],
      },
    });

    await userEvent.click(await screen.findByTestId("detail-locate"));
    await userEvent.click(await screen.findByTestId("locate-conflict-link"));

    expect(invokeMock).toHaveBeenCalledWith("link_book_edition", {
      sourceBookId: 3,
      targetBookId: 4,
      copyProgress: false,
    });
  });
});
