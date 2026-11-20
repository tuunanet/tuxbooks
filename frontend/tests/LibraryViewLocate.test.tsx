import { describe, expect, it } from "vite-plus/test";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { makeBook } from "./factories";
import { renderLibrary } from "./libraryViewHelpers";
import { invokeMock, mockInvoke, pickBookFileMock } from "./mocks/bridge";
import type { Book, LocateConflict } from "@/types/domain";

function conflictFixture(): { candidate: Book; owner: Book; conflict: LocateConflict } {
  const candidate = makeBook({ id: 3, title: "Lost", available: false });
  const owner = makeBook({ id: 4, title: "Machine Learning", path: "/library/present.epub" });
  return {
    candidate,
    owner,
    conflict: {
      owner,
      candidate,
      candidateState: {
        annotations: 2,
        hasProgress: true,
        progressPercent: 25,
        collections: 0,
        hasMetadataOverrides: false,
        providerLinks: 0,
        editionLinks: 0,
      },
    },
  };
}

describe("LibraryView Locate File", () => {
  it("shows why a picked file was rejected instead of failing silently", async () => {
    pickBookFileMock.mockResolvedValue("/library/already-there.epub");
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook({ id: 3, title: "Lost", available: false })],
      list_collections: [],
      reconnect_book: new Error("invalid input: that file is already in the library"),
      locate_book: new Error("invalid input: that file is already in the library"),
    });

    renderLibrary();
    await userEvent.click(await screen.findByTestId("missing-locate"));

    const error = await screen.findByTestId("library-locate-error");
    expect(error).toHaveTextContent("that file is already in the library");
    expect(error).not.toHaveTextContent("invalid input");
  });

  it("asks before touching a stale entry that still has reading state", async () => {
    pickBookFileMock.mockResolvedValue("/library/present.epub");
    const { candidate, owner, conflict } = conflictFixture();
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [candidate, owner],
      list_collections: [],
      reconnect_book: new Error("invalid input: that file is already in the library"),
      locate_book: { kind: "conflict", conflict },
      remove_book: true,
    });

    renderLibrary();
    await userEvent.click(await screen.findByTestId("missing-locate"));

    expect(await screen.findByTestId("locate-conflict-dialog")).toHaveTextContent(
      "Machine Learning",
    );
    await userEvent.click(screen.getByTestId("locate-conflict-history"));

    expect(invokeMock).toHaveBeenCalledWith("remove_book", { bookId: 3 });
    expect(await screen.findByTestId("library-locate-notice")).toHaveTextContent(
      "Moved to Reading history",
    );
  });

  it("reports a lossless merge in the library", async () => {
    pickBookFileMock.mockResolvedValue("/library/present.epub");
    const { candidate, owner } = conflictFixture();
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [candidate, owner],
      list_collections: [],
      reconnect_book: new Error("invalid input: that file is already in the library"),
      locate_book: {
        kind: "merged",
        book: owner,
        mergedFrom: { id: 3, title: "Lost" },
      },
    });

    renderLibrary();
    await userEvent.click(await screen.findByTestId("missing-locate"));

    expect(await screen.findByTestId("library-locate-notice")).toHaveTextContent(
      'Merged into "Machine Learning"',
    );
  });

  it("moves an empty duplicate to Reading history", async () => {
    pickBookFileMock.mockResolvedValue("/library/present.epub");
    const { candidate, owner } = conflictFixture();
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [candidate, owner],
      list_collections: [],
      reconnect_book: new Error("invalid input: that file is already in the library"),
      locate_book: {
        kind: "detached",
        book: owner,
        detachedFrom: { id: 3, title: "Lost" },
      },
    });

    renderLibrary();
    await userEvent.click(await screen.findByTestId("missing-locate"));

    expect(await screen.findByTestId("library-locate-notice")).toHaveTextContent(
      'Moved "Lost" to Reading history',
    );
  });
});
