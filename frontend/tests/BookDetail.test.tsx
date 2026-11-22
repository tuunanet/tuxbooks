import { describe, expect, it } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BookDetail } from "@/components/books/BookDetail";
import { AppShell } from "@/components/layout/AppShell";
import { ThemeStateProvider } from "@/state/ThemeStateProvider";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import type { AppState } from "@/state/appState";
import { makeBook, makeBookFile, makeProviderLink } from "./factories";
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
});
