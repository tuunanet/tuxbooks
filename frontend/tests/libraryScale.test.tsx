import { describe, expect, it, vi, afterEach } from "vite-plus/test";
import { act, render, screen, waitFor } from "@testing-library/react";

import { LibraryView } from "@/components/library/LibraryView";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import type { LibraryState } from "@/hooks/useLibrary";
import { ImportProvider } from "@/state/ImportProvider";
import { useLibrary } from "@/hooks/useLibrary";
import { EVENT_FLUSH_MS } from "@/hooks/useLibrary";
import { makeBook } from "./factories";
import { emitBridgeEvent, mockInvoke } from "./mocks/bridge";
import { fireResizeOn, stubElementRect } from "./mocks/resizeObserver";

describe("PERF-15: rendered library cards are a bounded window", () => {
  // Real timers: fake timers would freeze waitFor's polling while the initial
  // fetch settles across microtasks under variable worker load.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the DOM card count flat with 2,000 books in the library", async () => {
    stubElementRect(1200, 800);
    const books = Array.from({ length: 2000 }, (_, index) =>
      makeBook({ id: index + 1, title: `Book ${index + 1}` }),
    );
    mockInvoke({
      get_library_stats: { bookCount: books.length, collectionCount: 0 },
      list_books: books,
    });

    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <ImportProvider>
            <LibraryView section={{ kind: "smart", id: "all-books" }} />
          </ImportProvider>
        </LibraryDataProvider>
      </AppStateProvider>,
    );
    const gridEl = await screen.findByTestId("book-grid");

    // jsdom has no layout: give the scroller the offset geometry tanstack
    // reads, then fire only the scroller's observers, never the per-row ones.
    Object.defineProperty(gridEl, "offsetWidth", { value: 1200, configurable: true });
    Object.defineProperty(gridEl, "offsetHeight", { value: 800, configurable: true });
    act(() => fireResizeOn(gridEl, 1200, 800));

    // Six columns at 1200×800; the window stays constant as the library grows.
    await waitFor(() => expect(screen.getAllByTestId("book-card").length).toBeGreaterThan(0));
    const cards = screen.getAllByTestId("book-card");
    expect(cards.length).toBeLessThanOrEqual(120);

    expect(screen.queryByText("Book 1999")).not.toBeInTheDocument();
    expect(screen.getByTestId("library-stats")).toHaveTextContent("2000 books");
  });
});

describe("PERF-16: backend book events commit in batches", () => {
  it("50 library-changed events produce a handful of commits, not 50", async () => {
    vi.useFakeTimers();
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
    });

    let renderCount = 0;
    function Probe() {
      const { books }: LibraryState = useLibrary();
      renderCount += 1;
      return <div data-testid="probe">{books.length}</div>;
    }

    render(
      <LibraryDataProvider>
        <Probe />
      </LibraryDataProvider>,
    );

    await act(async () => {});
    const baseline = renderCount;

    await act(() => {
      for (let index = 0; index < 50; index += 1) {
        emitBridgeEvent("library-changed", {
          kind: "changed",
          book: makeBook({ id: index + 1, title: `Event Book ${index + 1}` }),
        });
      }
    });
    act(() => {
      vi.advanceTimersByTime(EVENT_FLUSH_MS + 50);
    });

    // One buffered flush should render a handful of times, not once per event.
    expect(renderCount - baseline).toBeLessThanOrEqual(6);
    expect(screen.getByTestId("probe")).toHaveTextContent("50");
    vi.useRealTimers();
  });
});
