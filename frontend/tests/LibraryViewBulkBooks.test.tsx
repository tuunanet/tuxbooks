import { describe, expect, it, vi } from "vite-plus/test";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { makeBook } from "./factories";
import { alpha, beta, item, renderLibrary } from "./libraryViewHelpers";
import { invokeMock, mockInvoke } from "./mocks/bridge";

describe("LibraryView bulk book actions", () => {
  it("asks once before a bulk remove, naming the count and the files on disk", async () => {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
      list_collections: [],
    });

    renderLibrary();
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { ctrlKey: true });
    fireEvent.contextMenu(item(cards, 1));

    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove 2 Books from Library" }),
    );

    const dialogs = await screen.findAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(item(dialogs, 0)).toHaveTextContent("Remove 2 books from the library?");
    expect(item(dialogs, 0)).toHaveTextContent(/files on disk/i);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("remove_book", expect.anything());
    expect(screen.getByTestId("selection-count")).toHaveTextContent("2 books selected");
  });

  it("removes every selected book, refreshes once, clears the selection and reports on the bar", async () => {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 3, collectionCount: 0 },
      list_books: [
        alpha(),
        beta(),
        makeBook({ id: 3, title: "Gamma", addedAt: "2026-03-01T00:00:00.000Z" }),
      ],
      list_collections: [],
    });

    renderLibrary();
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { ctrlKey: true });
    fireEvent.click(item(cards, 2), { ctrlKey: true });
    fireEvent.contextMenu(item(cards, 2));

    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove 3 Books from Library" }),
    );
    await userEvent.click(await screen.findByTestId("bulk-remove-confirm"));

    expect(invokeMock).toHaveBeenCalledWith("remove_book", { bookId: 1 });
    expect(invokeMock).toHaveBeenCalledWith("remove_book", { bookId: 2 });
    expect(invokeMock).toHaveBeenCalledWith("remove_book", { bookId: 3 });

    // The mount fetch plus exactly one refresh after the loop.
    expect(invokeMock.mock.calls.filter(([method]) => method === "list_books")).toHaveLength(2);

    await waitFor(() =>
      expect(screen.getByTestId("selection-message")).toHaveTextContent(
        "Removed 3 books from the library",
      ),
    );
    expect(screen.queryByTestId("selection-count")).not.toBeInTheDocument();

    const after = await screen.findAllByTestId("book-card");
    expect(after.map((card) => card.getAttribute("aria-pressed"))).toEqual([
      "false",
      "false",
      "false",
    ]);
  });

  it("retires the result note on its own", async () => {
    // The note expires on a timer; fake clocks drive that one assertion
    // while every interaction stays synchronous (fireEvent, no waits).
    vi.useFakeTimers();
    try {
      mockInvoke({
        get_library_stats: { bookCount: 2, collectionCount: 0 },
        list_books: [alpha(), beta()],
        list_collections: [],
      });

      renderLibrary();
      await act(async () => {});

      const cards = screen.getAllByTestId("book-card");
      fireEvent.click(item(cards, 0));
      fireEvent.click(item(cards, 1), { ctrlKey: true });
      fireEvent.contextMenu(item(cards, 1));
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove 2 Books from Library" }));
      fireEvent.click(screen.getByTestId("bulk-remove-confirm"));

      // The per-book calls and the refresh resolve as microtasks.
      await act(async () => {});
      expect(screen.getByTestId("selection-message")).toHaveTextContent(
        "Removed 2 books from the library",
      );

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(screen.queryByTestId("selection-bar")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes a single book from the menu with no dialog", async () => {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [alpha()],
      list_collections: [],
    });

    renderLibrary();
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.contextMenu(item(cards, 0));

    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove from Library" }));

    expect(invokeMock).toHaveBeenCalledWith("remove_book", { bookId: 1 });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("selection-bar")).not.toBeInTheDocument();
  });

  /** Mixed progress: Alpha and Beta are unfinished, Gamma already at 100%. */
  function mockMixedProgressLibrary() {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 3, collectionCount: 0 },
      list_books: [
        alpha(),
        beta(),
        makeBook({
          id: 3,
          title: "Gamma",
          addedAt: "2026-03-01T00:00:00.000Z",
          progressPercent: 100,
        }),
      ],
      list_collections: [],
      mark_book_finished: null,
    });
  }

  /** Selects every card, then picks Mark as Finished off the bulk menu. */
  async function bulkMarkFinished() {
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { ctrlKey: true });
    fireEvent.click(item(cards, 2), { ctrlKey: true });
    fireEvent.contextMenu(item(cards, 2));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Mark as Finished" }));
  }

  it("marks only the unfinished selected books, skipping the finished one", async () => {
    mockMixedProgressLibrary();

    renderLibrary();
    await bulkMarkFinished();

    await waitFor(() =>
      expect(screen.getByTestId("selection-message")).toHaveTextContent(
        "Marked 2 books as finished",
      ),
    );
    const marks = invokeMock.mock.calls.filter(([method]) => method === "mark_book_finished");
    expect(marks).toHaveLength(2);
    expect(marks.map(([, params]) => params)).toEqual(
      expect.arrayContaining([{ bookId: 1 }, { bookId: 2 }]),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("mark_book_finished", { bookId: 3 });
  });

  it("keeps the selection after the batch", async () => {
    mockMixedProgressLibrary();

    renderLibrary();
    await bulkMarkFinished();

    await waitFor(() =>
      expect(screen.getByTestId("selection-message")).toHaveTextContent(
        "Marked 2 books as finished",
      ),
    );
    expect(screen.getByTestId("selection-count")).toHaveTextContent("3 books selected");
    expect(
      (await screen.findAllByTestId("book-card")).map((card) => card.getAttribute("aria-pressed")),
    ).toEqual(["true", "true", "true"]);
  });

  it("refreshes the library exactly once after the batch", async () => {
    mockMixedProgressLibrary();

    renderLibrary();
    await bulkMarkFinished();

    await waitFor(() =>
      expect(screen.getByTestId("selection-message")).toHaveTextContent(
        "Marked 2 books as finished",
      ),
    );
    // The mount fetch plus exactly one refresh after the loop.
    expect(invokeMock.mock.calls.filter(([method]) => method === "list_books")).toHaveLength(2);
  });

  it("skips the bridge entirely when every selected book is finished", async () => {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 3, collectionCount: 0 },
      list_books: [
        makeBook({
          id: 1,
          title: "Alpha",
          addedAt: "2026-01-01T00:00:00.000Z",
          progressPercent: 100,
        }),
        makeBook({
          id: 2,
          title: "Beta",
          addedAt: "2026-02-01T00:00:00.000Z",
          progressPercent: 100,
        }),
        makeBook({
          id: 3,
          title: "Gamma",
          addedAt: "2026-03-01T00:00:00.000Z",
          progressPercent: 100,
        }),
      ],
      list_collections: [],
      mark_book_finished: null,
    });

    renderLibrary();
    await bulkMarkFinished();

    await waitFor(() =>
      expect(screen.getByTestId("selection-message")).toHaveTextContent(
        "All selected books are already finished",
      ),
    );
    expect(
      invokeMock.mock.calls.filter(([method]) => method === "mark_book_finished"),
    ).toHaveLength(0);
    expect(invokeMock.mock.calls.filter(([method]) => method === "list_books")).toHaveLength(1);
    expect(screen.getByTestId("selection-count")).toHaveTextContent("3 books selected");
  });
});
