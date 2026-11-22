import { describe, expect, it } from "vite-plus/test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BookDetail } from "@/components/books/BookDetail";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import type { AppState } from "@/state/appState";
import { makeBook, makeBookFile, makeReadingHistoryBook } from "./factories";
import { invokeMock, mockInvoke } from "./mocks/bridge";

function renderDetail(
  state: Partial<AppState> = {},
  books: ReturnType<typeof makeBook>[] = [makeBook()],
  files = [makeBookFile()],
  extraResponses: Record<string, unknown> = {},
) {
  mockInvoke({
    get_library_stats: { bookCount: books.length, collectionCount: 0 },
    list_books: books,
    list_book_files: files,
    list_collections: [],
    ...extraResponses,
  });
  return render(
    <AppStateProvider
      initialState={{
        view: "detail",
        section: { kind: "smart", id: "all-books" },
        selectedBookId: 1,
        libraryQuery: "",
        ...state,
      }}
    >
      <LibraryDataProvider>
        <BookDetail />
      </LibraryDataProvider>
    </AppStateProvider>,
  );
}

describe("BookDetail editions and maintenance", () => {
  it("links an existing book as another edition and explains that annotations stay", async () => {
    const historyBook = makeReadingHistoryBook({
      id: 41,
      title: "The Navigation Edition",
      author: "Grace Hopper",
      annotationCount: 2,
    });
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      list_reading_history: [historyBook],
      link_book_edition: {
        sourceBookId: 41,
        targetBookId: 1,
        sourceBookUid: historyBook.bookUid,
        targetBookUid: "0123456789abcdef0123456789abcdef",
        copiedProgressPercent: 42,
        movedProviders: ["hardcover"],
      },
    });

    render(
      <AppStateProvider
        initialState={{
          view: "detail",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
        }}
      >
        <LibraryDataProvider>
          <BookDetail />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    await screen.findByTestId("detail-title");
    await userEvent.click(screen.getByTestId("detail-link-edition"));

    const dialog = await screen.findByTestId("link-edition-dialog");
    expect(dialog).toHaveTextContent(/provider link and its reading status move/i);
    expect(within(dialog).getByTestId("link-edition-annotation-note")).toHaveTextContent(
      /annotations stay with the other edition; they do not move automatically/i,
    );

    await screen.findByRole("option", { name: /The Navigation Edition/ });
    await userEvent.selectOptions(screen.getByTestId("link-edition-select"), "41");
    await userEvent.click(screen.getByTestId("link-edition-confirm"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("link_book_edition", {
        sourceBookId: 41,
        targetBookId: 1,
      });
    });
  });

  it("lists linked editions with the surface each one belongs to", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      list_book_editions: [
        {
          id: 41,
          bookUid: "abcdefabcdefabcdefabcdefabcdefab",
          title: "The Navigation Edition",
          author: "Grace Hopper",
          inLibrary: false,
        },
      ],
    });

    render(
      <AppStateProvider
        initialState={{
          view: "detail",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
        }}
      >
        <LibraryDataProvider>
          <BookDetail />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    const editions = await screen.findByTestId("detail-editions");
    expect(editions).toHaveTextContent("The Navigation Edition");
    expect(editions).toHaveTextContent("Grace Hopper");
    expect(editions).toHaveTextContent("Detached");
    expect(screen.queryByTestId("detail-editions-empty")).not.toBeInTheDocument();
  });

  it("opens Reset and Forget confirmations from the reading-data section", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      reset_book_reading_data: true,
      forget_book: { forgottenBookId: 1, replacementBookId: 2, trashId: 9 },
    });
    render(
      <AppStateProvider
        initialState={{
          view: "detail",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
        }}
      >
        <LibraryDataProvider>
          <BookDetail />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    await screen.findByTestId("detail-title");
    await userEvent.click(screen.getByTestId("detail-reset"));
    expect(screen.getByTestId("reset-book-dialog")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("reset-book-confirm"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("reset_book_reading_data", { bookId: 1 });
    });

    await userEvent.click(screen.getByTestId("detail-forget"));
    expect(screen.getByTestId("forget-book-dialog")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("forget-book-confirm"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("forget_book", { bookId: 1 });
    });
  });

  it("warns about a book that could not be indexed and retries from the detail", async () => {
    let hashState: "failed" | "hashed" = "failed";
    invokeMock.mockImplementation((method: string) => {
      switch (method) {
        case "get_library_stats":
          return Promise.resolve({ bookCount: 1, collectionCount: 0 });
        case "list_books":
          return Promise.resolve([makeBook({ hashState })]);
        case "retry_indexing":
          hashState = "hashed";
          return Promise.resolve({ bookId: 1, hashState: "hashed" });
        case "get_book_metadata":
          return Promise.resolve(null);
        default:
          return Promise.resolve([]);
      }
    });
    render(
      <AppStateProvider
        initialState={{
          view: "detail",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
        }}
      >
        <LibraryDataProvider>
          <BookDetail />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    expect(await screen.findByTestId("detail-indexing-warning")).toBeInTheDocument();
    expect(screen.getByTestId("detail-retry-indexing")).toHaveTextContent("Retry indexing");

    await userEvent.click(screen.getByTestId("detail-retry-indexing"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("retry_indexing", { bookId: 1 });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("detail-indexing-warning")).not.toBeInTheDocument();
    });
  });

  it("keeps the warning and shows the error when the retry stays failed", async () => {
    renderDetail({}, [makeBook({ hashState: "failed" })], [makeBookFile()], {
      retry_indexing: { bookId: 1, hashState: "failed" },
    });

    expect(await screen.findByTestId("detail-indexing-warning")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("detail-retry-indexing"));
    expect(await screen.findByTestId("detail-indexing-error")).toHaveTextContent(
      "still could not index",
    );
    expect(screen.getByTestId("detail-indexing-warning")).toBeInTheDocument();
  });

  it("disables Retry indexing while a retry is in flight", async () => {
    let resolveRetry: ((value: { bookId: number; hashState: "failed" }) => void) | undefined;
    invokeMock.mockImplementation((method: string) => {
      switch (method) {
        case "get_library_stats":
          return Promise.resolve({ bookCount: 1, collectionCount: 0 });
        case "list_books":
          return Promise.resolve([makeBook({ hashState: "failed" })]);
        case "get_book_metadata":
          return Promise.resolve(null);
        case "retry_indexing":
          return new Promise((resolve) => {
            resolveRetry = resolve;
          });
        default:
          return Promise.resolve([]);
      }
    });
    render(
      <AppStateProvider
        initialState={{
          view: "detail",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
        }}
      >
        <LibraryDataProvider>
          <BookDetail />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    const button = await screen.findByTestId("detail-retry-indexing");
    await userEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await userEvent.click(button);
    expect(invokeMock.mock.calls.filter(([method]) => method === "retry_indexing")).toHaveLength(1);

    resolveRetry?.({ bookId: 1, hashState: "failed" });
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it("does not warn for a hashed or pending book", async () => {
    const hashed = renderDetail({}, [makeBook({ hashState: "hashed" })]);
    await screen.findByTestId("detail-title");
    expect(screen.queryByTestId("detail-indexing-warning")).not.toBeInTheDocument();
    hashed.unmount();

    renderDetail({}, [makeBook({ hashState: "pending" })]);
    await screen.findByTestId("detail-title");
    expect(screen.queryByTestId("detail-indexing-warning")).not.toBeInTheDocument();
  });
});
