import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ReadingHistoryView } from "@/components/history/ReadingHistoryView";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { makeReadingHistoryBook } from "./factories";
import { mockInvoke } from "./mocks/bridge";
import { fireResizeOn, stubElementRect } from "./mocks/resizeObserver";

function renderHistory(books: ReturnType<typeof makeReadingHistoryBook>[]) {
  mockInvoke({
    get_library_stats: { bookCount: 0, collectionCount: 0 },
    list_books: [],
    list_collections: [],
    list_reading_history: books,
    list_book_trash: [],
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
}

/** Fixed scroller geometry: jsdom has no layout, so hand the virtualizer one. */
async function mountScrollerGeometry() {
  const scroller = await screen.findByTestId("reading-history-scroller");
  Object.defineProperty(scroller, "offsetWidth", { value: 1200, configurable: true });
  Object.defineProperty(scroller, "offsetHeight", { value: 800, configurable: true });
  act(() => fireResizeOn(scroller, 1200, 800));
  return scroller;
}

describe("PERF-18: rendered Reading history rows are a bounded window", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the DOM row count flat with a 10,002-book history", async () => {
    stubElementRect(1200, 800);
    const books = Array.from({ length: 10002 }, (_, index) =>
      makeReadingHistoryBook({ id: index + 1, title: `History ${index + 1}` }),
    );
    renderHistory(books);
    await mountScrollerGeometry();

    // A 1200×800 viewport at ~114px rows shows ~7 rows plus overscan; the
    // window must be that bounded slice, constant as the history grows.
    await waitFor(() =>
      expect(screen.getAllByTestId("reading-history-book").length).toBeGreaterThan(0),
    );
    const rows = screen.getAllByTestId("reading-history-book");
    expect(rows.length).toBeLessThanOrEqual(48);

    // The history holds 10,002 books; the far end must not be in the DOM.
    expect(screen.queryByText("History 10001")).not.toBeInTheDocument();
    expect(screen.getByTestId("reading-history-count")).toHaveTextContent("10002 books");
  });

  it("select-all still selects every book while only a window is mounted", async () => {
    stubElementRect(1200, 800);
    const books = Array.from({ length: 10002 }, (_, index) =>
      makeReadingHistoryBook({ id: index + 1, title: `History ${index + 1}` }),
    );
    renderHistory(books);
    await mountScrollerGeometry();

    await waitFor(() =>
      expect(screen.getAllByTestId("reading-history-book").length).toBeGreaterThan(0),
    );
    await userEvent.click(screen.getByTestId("reading-history-select-all"));
    expect(screen.getByTestId("reading-history-forget-selected")).toHaveTextContent(
      "Forget selected (10002)",
    );
  });
});
