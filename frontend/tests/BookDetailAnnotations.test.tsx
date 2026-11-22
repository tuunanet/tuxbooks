import { describe, expect, it } from "vite-plus/test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BookDetail } from "@/components/books/BookDetail";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { useAppState } from "@/state/appState";
import { makeAnnotation, makeBook } from "./factories";
import { invokeMock, mockInvoke } from "./mocks/bridge";

describe("BookDetail annotations and bookmarks", () => {
  it("lists only the book's highlights with their locations and notes", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      list_annotations: [
        makeAnnotation({
          id: 11,
          kind: "highlight",
          cfi: '{"href":"chapter-01.xhtml"}',
          chapterHref: "OEBPS/chapter-01.xhtml",
          pageNumber: null,
          text: "A marked passage",
          color: "green",
          note: "remember this",
          rects: null,
        }),
        makeAnnotation({
          id: 12,
          kind: "bookmark",
          cfi: '{"href":"chapter-01.xhtml"}',
          chapterHref: "OEBPS/chapter-01.xhtml",
          pageNumber: null,
          text: null,
          rects: null,
        }),
        makeAnnotation({
          id: 13,
          kind: "highlight",
          cfi: null,
          chapterHref: null,
          pageNumber: 7,
          text: "Page seven line",
          color: "blue",
          note: null,
        }),
      ],
    });

    render(
      <AppStateProvider
        initialState={{
          view: "detail",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          detailTab: "highlights",
          libraryQuery: "",
        }}
      >
        <LibraryDataProvider>
          <BookDetail />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    const list = await screen.findByTestId("detail-highlights");
    expect(invokeMock).toHaveBeenCalledWith("list_annotations", { bookId: 1 });
    expect(screen.getByText("2 highlights")).toBeInTheDocument();
    expect(list).toHaveTextContent("A marked passage");
    expect(list).toHaveTextContent("remember this");
    expect(list).toHaveTextContent("Chapter 01");
    expect(list).toHaveTextContent("Page seven line");
    expect(list).toHaveTextContent("Page 7");
    // Highlights tab lists only highlights; bookmarks have their own tab.
    expect(screen.queryByTestId("detail-highlight-12")).not.toBeInTheDocument();
  });

  it("shows an empty state when the book has no highlights", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      list_annotations: [],
    });

    render(
      <AppStateProvider
        initialState={{
          view: "detail",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          detailTab: "highlights",
          libraryQuery: "",
        }}
      >
        <LibraryDataProvider>
          <BookDetail />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    expect(await screen.findByTestId("detail-highlights-empty")).toHaveTextContent(
      /no highlights yet/i,
    );
  });

  it("opens the reader at the clicked highlight", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      list_annotations: [makeAnnotation({ id: 21, text: "Jump back here" })],
    });

    function StateProbe() {
      const { view, readerTargetAnnotationId } = useAppState();
      return (
        <span data-testid="state-probe">{`${view}:${readerTargetAnnotationId ?? "none"}`}</span>
      );
    }

    render(
      <AppStateProvider
        initialState={{
          view: "detail",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          detailTab: "highlights",
          libraryQuery: "",
        }}
      >
        <LibraryDataProvider>
          <BookDetail />
          <StateProbe />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    await userEvent.click(await screen.findByTestId("detail-highlight-21"));
    expect(screen.getByTestId("state-probe")).toHaveTextContent("reader:21");
  });

  it("lists bookmarks after Highlights with EPUB and PDF locations", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      list_annotations: [
        makeAnnotation({
          id: 31,
          kind: "bookmark",
          cfi: '{"href":"chapter-02.xhtml","locations":{"progression":0.4}}',
          chapterHref: "OEBPS/chapter-02.xhtml",
          pageNumber: null,
          text: null,
          rects: null,
        }),
        makeAnnotation({
          id: 32,
          kind: "bookmark",
          cfi: null,
          chapterHref: null,
          pageNumber: 9,
          text: null,
          rects: null,
          label: "Key idea",
          note: "Worth revisiting",
        }),
        makeAnnotation({ id: 33, kind: "highlight", text: "Not a bookmark" }),
      ],
    });

    render(
      <AppStateProvider
        initialState={{
          view: "detail",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          detailTab: "bookmarks",
          libraryQuery: "",
        }}
      >
        <LibraryDataProvider>
          <BookDetail />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    await screen.findByTestId("detail-bookmarks");
    expect(screen.getByText("2 bookmarks")).toBeInTheDocument();
    expect(screen.getByText("Chapter 02 · 40% through chapter")).toBeInTheDocument();
    expect(screen.getByText(/Page 9/)).toBeInTheDocument();
    expect(screen.getByText("Worth revisiting")).toBeInTheDocument();
    expect(screen.getByTestId("detail-bookmark-progress-31")).toBeInTheDocument();
    expect(screen.getByText("Key idea")).toBeInTheDocument();
    expect(screen.queryByTestId("detail-bookmark-33")).not.toBeInTheDocument();

    expect(
      within(screen.getByTestId("detail-tabs"))
        .getAllByRole("tab")
        .map((tab) => tab.textContent),
    ).toEqual(["Overview", "Metadata", "Highlights", "Bookmarks"]);
  });

  it("shows an empty state when the book has no bookmarks", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      list_annotations: [],
    });

    render(
      <AppStateProvider
        initialState={{
          view: "detail",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          detailTab: "bookmarks",
          libraryQuery: "",
        }}
      >
        <LibraryDataProvider>
          <BookDetail />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    expect(await screen.findByTestId("detail-bookmarks-empty")).toHaveTextContent(
      /no bookmarks yet/i,
    );
  });

  it("edits a bookmark label and caps it at 50 characters", async () => {
    const bookmark = makeAnnotation({
      id: 51,
      kind: "bookmark",
      cfi: null,
      chapterHref: null,
      pageNumber: 4,
      text: null,
      rects: null,
    });
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook({ format: "pdf" })],
      list_annotations: [bookmark],
      update_annotation: makeAnnotation({ ...bookmark, label: "Opening scene" }),
    });

    render(
      <AppStateProvider
        initialState={{
          view: "detail",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          detailTab: "bookmarks",
          libraryQuery: "",
        }}
      >
        <LibraryDataProvider>
          <BookDetail />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    await userEvent.click(await screen.findByTestId("detail-bookmark-label-51"));
    const input = screen.getByTestId("detail-bookmark-label-input");
    await userEvent.type(input, "x".repeat(60));
    expect(input).toHaveValue("x".repeat(50));

    await userEvent.clear(input);
    await userEvent.type(input, "Opening scene");
    await userEvent.click(screen.getByTestId("detail-bookmark-label-save"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_annotation", {
        id: 51,
        patch: { label: "Opening scene" },
      }),
    );
    expect(await screen.findByText("Opening scene")).toBeInTheDocument();
  });

  it("opens the reader at the clicked PDF bookmark", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook({ format: "pdf" })],
      list_annotations: [
        makeAnnotation({
          id: 41,
          kind: "bookmark",
          cfi: null,
          chapterHref: null,
          pageNumber: 5,
          text: null,
          rects: null,
        }),
      ],
    });

    function StateProbe() {
      const { view, readerTargetAnnotationId } = useAppState();
      return (
        <span data-testid="state-probe">{`${view}:${readerTargetAnnotationId ?? "none"}`}</span>
      );
    }

    render(
      <AppStateProvider
        initialState={{
          view: "detail",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          detailTab: "bookmarks",
          libraryQuery: "",
        }}
      >
        <LibraryDataProvider>
          <BookDetail />
          <StateProbe />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    await userEvent.click(await screen.findByTestId("detail-bookmark-41"));
    expect(screen.getByTestId("state-probe")).toHaveTextContent("reader:41");
  });
});
