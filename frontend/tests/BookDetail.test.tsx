import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { BookDetail } from "@/components/books/BookDetail";
import { AppShell } from "@/components/layout/AppShell";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import type { AppState } from "@/state/appState";
import { makeBook } from "./factories";
import { invokeMock, mockInvoke } from "./mocks/tauri";

function renderDetail(
  state: Partial<AppState> = {},
  books: ReturnType<typeof makeBook>[] = [makeBook()],
) {
  mockInvoke({
    get_library_stats: { bookCount: books.length, collectionCount: 0 },
    list_books: books,
  });
  return render(
    <AppStateProvider
      initialState={{
        view: "detail",
        section: { kind: "smart", id: "all-books" },
        selectedBookId: 1,
        libraryQuery: "",
        metadataEditorBookId: null,
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
    expect(facts).toHaveTextContent("Tuxbooks Press");
    expect(facts).toHaveTextContent("/tmp/library/minimal.epub");
    expect(screen.getByText("Back to All Books")).toBeInTheDocument();
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
          metadataEditorBookId: null,
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
    expect(facts).toHaveTextContent("ISBN—");
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

  it("opens the metadata editor from the Edit button (milestone 7)", async () => {
    // BookDetail fetches the curation view for the subjects row; the dialog
    // is only mounted after the click.
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
          metadataEditorBookId: null,
        }}
      />,
    );

    await screen.findByTestId("book-detail");
    expect(screen.getByTestId("detail-collections")).toHaveTextContent(/not in any collection/i);
    await userEvent.click(screen.getByTestId("detail-edit"));
    expect(await screen.findByTestId("metadata-dialog")).toBeInTheDocument();
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
          metadataEditorBookId: null,
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
    const facts = screen.getByTestId("detail-facts");
    expect(facts).toHaveTextContent("1843");
    expect(facts).toHaveTextContent("Analytical Engines #2");
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
          metadataEditorBookId: null,
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
      <AppShell
        initialState={{
          view: "detail",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
          metadataEditorBookId: null,
        }}
      />,
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
          metadataEditorBookId: null,
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
    const { open } = await import("@tauri-apps/plugin-dialog");
    vi.mocked(open).mockResolvedValue("/library/located/renamed.epub");

    renderDetail({}, [makeBook({ available: false })]);

    expect(await screen.findByTestId("detail-missing")).toBeInTheDocument();
    expect(screen.queryByTestId("detail-continue")).not.toBeInTheDocument();

    // Locate → plugin-dialog open → reconnect_book invocation.
    await userEvent.click(screen.getByTestId("detail-locate"));
    expect(open).toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("reconnect_book", {
      bookId: 1,
      path: "/library/located/renamed.epub",
    });
  });
});
