import { describe, expect, it } from "vite-plus/test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BookDetail } from "@/components/books/BookDetail";
import { AppShell } from "@/components/layout/AppShell";
import { ThemeStateProvider } from "@/state/ThemeStateProvider";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import type { AppState } from "@/state/appState";
import { useAppState } from "@/state/appState";
import {
  makeAnnotation,
  makeBook,
  makeBookFile,
  makeProviderLink,
  makeReadingHistoryBook,
} from "./factories";
import { invokeMock, mockInvoke, pickBookFileMock } from "./mocks/bridge";

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

describe("BookDetail", () => {
  it("renders cover, title, author, and the facts table", async () => {
    renderDetail();

    expect(await screen.findByTestId("detail-title")).toHaveTextContent("A Minimal Book");
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    const facts = screen.getByTestId("detail-facts");
    expect(facts).toHaveTextContent("Format");
    expect(facts).toHaveTextContent("EPUB");
    expect(facts).toHaveTextContent("Jan 1, 2026");
    expect(facts).toHaveTextContent("/tmp/library/minimal.epub");
    expect(screen.getByText("Back to All Books")).toBeInTheDocument();
  });

  it("lists every duplicate location and removes one copy", async () => {
    const first = makeBookFile({ id: 11, path: "/tmp/library/first.epub" });
    const second = makeBookFile({ id: 12, path: "/tmp/library/second.epub", active: false });

    renderDetail({}, [makeBook({ path: first.path })], [first, second], {
      remove_book_file: true,
    });

    const locations = await screen.findByTestId("detail-file-locations");
    await waitFor(() => {
      expect(locations).toHaveTextContent("/tmp/library/first.epub");
      expect(locations).toHaveTextContent("/tmp/library/second.epub");
    });
    // The active-file rule marks exactly one copy.
    expect(screen.getByTestId("detail-file-active-11")).toBeInTheDocument();
    expect(screen.queryByTestId("detail-file-active-12")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("detail-file-remove-12"));
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("remove_book_file", { bookId: 1, fileId: 12 });
    });
  });

  it("does not offer to remove a book's only file copy", async () => {
    renderDetail();

    expect(await screen.findByTestId("detail-file-locations")).toHaveTextContent(
      "/tmp/library/minimal.epub",
    );
    expect(screen.queryByTestId("detail-file-remove-1")).not.toBeInTheDocument();
  });

  it("shows a provider link that survived the file", async () => {
    renderDetail({}, [
      makeBook({
        providerLinks: [makeProviderLink({ provider: "hardcover", status: "finished" })],
      }),
    ]);

    await screen.findByTestId("detail-title");
    expect(screen.getByTestId("detail-providers")).toHaveTextContent("Hardcover · Finished");
  });

  it("shows a PDF badge and em-dashes for missing fields", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [
        makeBook({
          format: "pdf",
          publisher: null,
          language: null,
          isbn: null,
          lastOpenedAt: null,
        }),
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

    await screen.findByTestId("detail-title");
    // The PDF badge and the Format fact row both say "PDF".
    expect(screen.getAllByText("PDF")).toHaveLength(2);
    const facts = screen.getByTestId("detail-facts");
    expect(facts).toHaveTextContent("Last opened—");
  });

  it("shows the description only when present", async () => {
    const { unmount } = renderDetail();
    await screen.findByTestId("detail-title");
    expect(screen.getByText("A tiny EPUB used as a test fixture.")).toBeInTheDocument();
    unmount();

    // A fresh mount refetches with the updated mock; the provider does not
    // re-fetch on rerender.
    renderDetail({}, [makeBook({ description: null })]);
    await screen.findByTestId("detail-title");
    expect(screen.queryByText("Description")).not.toBeInTheDocument();
  });

  it("mounts the Metadata panel when its tab is selected", async () => {
    // BookDetail fetches the curation view for the subjects row; the Metadata
    // panel is only mounted once its tab is active.
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
    });

    render(
      <AppShell
        initialState={{
          view: "detail",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
        }}
      />,
    );

    await screen.findByTestId("book-detail");
    expect(screen.getByTestId("detail-collections")).toHaveTextContent(/not in any collection/i);
    await userEvent.click(screen.getByTestId("detail-tab-metadata"));
    expect(await screen.findByTestId("metadata-panel")).toBeInTheDocument();
  });

  it("shows the detail's subjects from the metadata view", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [
        makeBook({
          publicationDate: "1843",
          seriesId: 1,
          seriesIndex: 2,
          seriesName: "Analytical Engines",
        }),
      ],
      get_book_metadata: {
        bookId: 1,
        effective: {
          title: "A Minimal Book",
          subtitle: null,
          publisher: "Tuxbooks Press",
          language: "en",
          isbn: null,
          description: null,
          publicationDate: "1843",
          series: "Analytical Engines",
          seriesIndex: 2,
          authors: ["Ada Lovelace"],
          subjects: ["Computing", "Mathematics"],
        },
        source: {
          title: "A Minimal Book",
          subtitle: null,
          publisher: "Tuxbooks Press",
          language: "en",
          isbn: null,
          description: null,
          publicationDate: "1843",
          series: "Analytical Engines",
          seriesIndex: 2,
          authors: ["Ada Lovelace"],
          subjects: ["Computing", "Mathematics"],
        },
        overridden: {
          title: false,
          subtitle: false,
          publisher: false,
          language: false,
          isbn: false,
          description: false,
          publicationDate: false,
          series: false,
          cover: false,
          authors: false,
          subjects: false,
        },
        coverPath: null,
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

    await screen.findByTestId("book-detail");
    // The subjects arrive asynchronously from get_book_metadata.
    expect(await screen.findByText("Computing")).toBeInTheDocument();
    const subjects = screen.getByTestId("detail-subjects");
    expect(subjects).toHaveTextContent("Computing");
    expect(subjects).toHaveTextContent("Mathematics");
  });

  it("shows the Metadata tab with source divergence and file properties", async () => {
    const effective = {
      title: "A Minimal Book",
      subtitle: null,
      publisher: "Tuxbooks Press",
      language: "en",
      isbn: null,
      description: null,
      publicationDate: "1843",
      series: "Analytical Engines",
      seriesIndex: 2,
      authors: ["Ada Lovelace"],
      subjects: ["Computing"],
    };
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      get_book_metadata: {
        bookId: 1,
        effective,
        source: { ...effective, title: "File Garbled Title" },
        overridden: {
          title: true,
          subtitle: false,
          publisher: false,
          language: false,
          isbn: false,
          description: false,
          publicationDate: false,
          series: false,
          cover: false,
          authors: false,
          subjects: false,
        },
        coverPath: null,
        sourceCoverPath: null,
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

    await screen.findByTestId("book-detail");
    await userEvent.click(screen.getByTestId("detail-tab-metadata"));

    expect(await screen.findByTestId("metadata-panel")).toBeInTheDocument();
    // The title diverges from the file, so it carries the orange-dot marker.
    expect(screen.getByTestId("metadata-title-overridden")).toBeInTheDocument();
  });

  it("returns to the library from the back button", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
    });

    render(
      <AppShell
        initialState={{
          view: "detail",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
        }}
      />,
    );

    await screen.findByTestId("book-detail");
    await userEvent.click(screen.getByTestId("detail-back"));
    expect(await screen.findByTestId("library-view")).toBeInTheDocument();
    expect(screen.queryByTestId("book-detail")).not.toBeInTheDocument();
  });

  it("enters the reader from Continue Reading", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
    });

    render(
      // Continue Reading enters the reader view, which consumes the global
      // resolved theme for the auto reader surface.
      <ThemeStateProvider>
        <AppShell
          initialState={{
            view: "detail",
            section: { kind: "smart", id: "all-books" },
            selectedBookId: 1,
            libraryQuery: "",
          }}
        />
      </ThemeStateProvider>,
    );

    await screen.findByTestId("book-detail");
    await userEvent.click(screen.getByTestId("detail-continue"));
    expect(await screen.findByTestId("reader-view")).toBeInTheDocument();
  });

  it("shows an honest state when the selected book is missing", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
    });

    render(
      <AppStateProvider
        initialState={{
          view: "detail",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 99,
          libraryQuery: "",
        }}
      >
        <LibraryDataProvider>
          <BookDetail />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    expect(await screen.findByTestId("book-detail-missing")).toBeInTheDocument();
  });

  it("replaces Continue Reading with recovery actions when the file is unavailable", async () => {
    pickBookFileMock.mockResolvedValue("/library/located/renamed.epub");

    renderDetail({}, [makeBook({ available: false })]);

    expect(await screen.findByTestId("detail-missing")).toBeInTheDocument();
    expect(screen.queryByTestId("detail-continue")).not.toBeInTheDocument();

    // Locate → native file picker → reconnect_book invocation.
    await userEvent.click(screen.getByTestId("detail-locate"));
    expect(pickBookFileMock).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("reconnect_book", {
      bookId: 1,
      path: "/library/located/renamed.epub",
    });
  });

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
    expect(editions).toHaveTextContent("Reading history");
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
