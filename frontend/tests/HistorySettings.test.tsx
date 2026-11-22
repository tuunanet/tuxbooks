import { beforeEach, describe, expect, it } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppShell } from "@/components/layout/AppShell";
import { HistorySettings } from "@/components/settings/HistorySettings";
import { AppStateProvider } from "@/state/AppStateProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import {
  makeBook,
  makeBookTrashEntry,
  makeProviderLink,
  makeReadingHistoryBook,
} from "./factories";
import { invokeMock, mockInvoke, pickBookFileMock } from "./mocks/bridge";

function renderHistory(
  history: ReturnType<typeof makeReadingHistoryBook>[],
  trash: ReturnType<typeof makeBookTrashEntry>[] = [],
  library: ReturnType<typeof makeBook>[] = [],
) {
  mockInvoke({
    get_library_stats: { bookCount: library.length, collectionCount: 0 },
    list_books: library,
    list_collections: [],
    list_reading_history: history,
    list_book_trash: trash,
  });
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

beforeEach(() => {
  invokeMock.mockClear();
  pickBookFileMock.mockReset();
  pickBookFileMock.mockResolvedValue(null);
});

describe("HistorySettings", () => {
  it("shows the durable snapshot, live progress, and annotation count", async () => {
    renderHistory([
      makeReadingHistoryBook({ id: 41, title: "Durable Title", progressPercent: 42.5 }),
    ]);

    expect(await screen.findByTestId("history-book")).toBeInTheDocument();
    expect(screen.getByText("Durable Title")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByTestId("history-progress")).toHaveTextContent("43% read");
    expect(screen.getByTestId("history-annotations")).toHaveTextContent("3 annotations");
    expect(screen.getByTestId("history-count")).toHaveTextContent("1 record");
    expect(invokeMock).toHaveBeenCalledWith("list_reading_history", {});
  });

  it("shows the provider link that survived the file", async () => {
    renderHistory([
      makeReadingHistoryBook({
        providerLinks: [makeProviderLink({ provider: "hardcover", status: "reading" })],
      }),
    ]);

    const provider = await screen.findByTestId("history-provider");
    expect(provider).toHaveTextContent("Hardcover · Reading");
  });

  it("names the surviving book on an empty duplicate", async () => {
    renderHistory([
      makeReadingHistoryBook({
        id: 41,
        title: "Book",
        isEmptyDuplicate: true,
        duplicateOfTitle: "Machine Learning",
      }),
    ]);

    const label = await screen.findByTestId("history-duplicate-of");
    expect(label).toHaveTextContent("Empty duplicate of Machine Learning");
  });

  it("leaves an ordinary detached row unlabelled", async () => {
    renderHistory([makeReadingHistoryBook({ id: 41 })]);

    await screen.findByTestId("history-book");
    expect(screen.queryByTestId("history-duplicate-of")).not.toBeInTheDocument();
  });

  it("searches detached records through the sidecar", async () => {
    renderHistory([makeReadingHistoryBook({ title: "Searchable History" })]);

    await screen.findByTestId("history-book");
    await userEvent.type(screen.getByTestId("history-search"), "navigation");

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("list_reading_history", { query: "navigation" });
    });
  });

  it("explains what an empty detached list is for", async () => {
    renderHistory([]);

    const empty = await screen.findByTestId("history-empty");
    expect(empty).toHaveTextContent("No detached records");
    expect(empty).toHaveTextContent("Relink a file");
  });

  it("relinks a picked file and refreshes both surfaces", async () => {
    pickBookFileMock.mockResolvedValueOnce("/tmp/library/found.epub");
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
      list_collections: [],
      list_reading_history: [makeReadingHistoryBook({ id: 41 })],
      list_book_trash: [],
      relink_book: makeBook({ id: 41, title: "A Fine History" }),
    });
    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <ImportProvider>
            <HistorySettings />
          </ImportProvider>
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    await screen.findByTestId("history-book");
    await userEvent.click(screen.getByTestId("history-relink-41"));

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

  it("lists forgotten books on their own tab", async () => {
    renderHistory(
      [makeReadingHistoryBook({ id: 41 })],
      [makeBookTrashEntry({ id: 7, title: "Old Copy" })],
    );

    await screen.findByTestId("history-book");
    await userEvent.click(screen.getByTestId("history-tab-forgotten"));

    expect(screen.getByTestId("recently-forgotten")).toHaveTextContent("Old Copy");
    expect(screen.getByTestId("recently-forgotten")).toHaveTextContent("restorable for 30 days");
  });

  it("says when nothing is waiting to be restored", async () => {
    renderHistory([makeReadingHistoryBook({ id: 41 })], []);

    await screen.findByTestId("history-book");
    await userEvent.click(screen.getByTestId("history-tab-forgotten"));

    expect(screen.getByTestId("history-forgotten-empty")).toHaveTextContent(
      "Nothing is waiting to be restored",
    );
  });

  it("opens from a deep link instead of a sidebar place", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
      list_collections: [],
      list_reading_history: [],
      list_book_trash: [],
    });
    render(
      <AppShell
        initialState={{
          view: "library",
          section: { kind: "smart", id: "all-books" },
          settingsOpen: true,
          settingsSection: "history",
          selectedBookId: null,
          libraryQuery: "",
        }}
      />,
    );

    expect(await screen.findByTestId("settings-window")).toBeInTheDocument();
    expect(await screen.findByTestId("history-settings-view")).toBeInTheDocument();
    // The library sidebar no longer carries the view as a place.
    expect(screen.queryByRole("button", { name: "Reading history" })).not.toBeInTheDocument();
  });
});
