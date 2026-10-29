import { beforeEach, describe, expect, it } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ReadingHistoryView } from "@/components/history/ReadingHistoryView";
import { AppShell } from "@/components/layout/AppShell";
import { AppStateProvider } from "@/state/AppStateProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { makeBook, makeProviderLink, makeReadingHistoryBook } from "./factories";
import { invokeMock, mockInvoke, pickBookFileMock } from "./mocks/bridge";

function renderHistory(
  history: ReturnType<typeof makeReadingHistoryBook>[],
  library: ReturnType<typeof makeBook>[] = [],
) {
  mockInvoke({
    get_library_stats: { bookCount: library.length, collectionCount: 0 },
    list_books: library,
    list_collections: [],
    list_reading_history: history,
  });
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
  pickBookFileMock.mockReset();
  pickBookFileMock.mockResolvedValue(null);
});

describe("ReadingHistoryView", () => {
  it("shows the durable snapshot, live progress, and annotation count", async () => {
    renderHistory([
      makeReadingHistoryBook({ id: 41, title: "Durable Title", progressPercent: 42.5 }),
    ]);

    expect(await screen.findByTestId("reading-history-book")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Reading history" })).toBeInTheDocument();
    expect(screen.getByText("Durable Title")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByTestId("reading-history-progress")).toHaveTextContent("43% read");
    expect(screen.getByTestId("reading-history-annotations")).toHaveTextContent("3 annotations");
    expect(screen.getByTestId("reading-history-count")).toHaveTextContent("1 book");
    expect(invokeMock).toHaveBeenCalledWith("list_reading_history", {});
  });

  it("shows the provider link that survived the file", async () => {
    renderHistory([
      makeReadingHistoryBook({
        providerLinks: [makeProviderLink({ provider: "hardcover", status: "reading" })],
      }),
    ]);

    const provider = await screen.findByTestId("reading-history-provider");
    expect(provider).toHaveTextContent("Hardcover · Reading");
  });

  it("searches Reading history through the sidecar", async () => {
    renderHistory([makeReadingHistoryBook({ title: "Searchable History" })]);

    await screen.findByTestId("reading-history-book");
    await userEvent.type(screen.getByTestId("reading-history-search"), "navigation");

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("list_reading_history", { query: "navigation" });
    });
  });

  it("explains what an empty Reading history is for", async () => {
    renderHistory([]);

    const empty = await screen.findByTestId("reading-history-empty");
    expect(empty).toHaveTextContent("No Reading history yet");
    expect(empty).toHaveTextContent("Relink a file");
  });

  it("relinks a picked file and refreshes both surfaces", async () => {
    pickBookFileMock.mockResolvedValueOnce("/tmp/library/found.epub");
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
      list_collections: [],
      list_reading_history: [makeReadingHistoryBook({ id: 41 })],
      relink_book: makeBook({ id: 41, title: "A Fine History" }),
    });
    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <ImportProvider>
            <ReadingHistoryView />
          </ImportProvider>
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    await screen.findByTestId("reading-history-book");
    await userEvent.click(screen.getByTestId("reading-history-relink-41"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("relink_book", {
        bookId: 41,
        path: "/tmp/library/found.epub",
      });
    });
    // The library payload is re-fetched, so the returned book shows up in the
    // library without a restart.
    await waitFor(() => {
      expect(invokeMock.mock.calls.filter(([method]) => method === "list_books")).toHaveLength(2);
    });
  });

  it("renders the view from the sidebar section", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
      list_collections: [],
      list_reading_history: [],
    });
    render(
      <AppShell
        initialState={{
          view: "library",
          section: { kind: "reading-history" },
          selectedBookId: null,
          libraryQuery: "",
        }}
      />,
    );

    expect(await screen.findByTestId("reading-history-view")).toBeInTheDocument();
    expect(screen.queryByTestId("library-view")).not.toBeInTheDocument();
  });
});
