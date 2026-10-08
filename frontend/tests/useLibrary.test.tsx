import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EVENT_FLUSH_MS, useLibraryData } from "@/hooks/useLibrary";
import { makeBook } from "./factories";
import { emitBridgeEvent, mockInvoke } from "./mocks/bridge";

const emptyLibrary = {
  get_library_stats: { bookCount: 0, collectionCount: 0 },
  list_books: [] as ReturnType<typeof makeBook>[],
};

describe("useLibraryData import-progress streaming", () => {
  it("adds books emitted through import-progress while a scan runs", async () => {
    mockInvoke(emptyLibrary);
    const { result } = renderHook(() => useLibraryData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act_emit(
      makeBook({ id: 7, title: "Streaming PDF", format: "pdf", coverPath: "/covers/x.png" }),
    );

    await waitFor(() => expect(result.current.books).toHaveLength(1));
    expect(result.current.books.at(0)).toMatchObject({
      title: "Streaming PDF",
      coverPath: "/covers/x.png",
    });
  });

  it("replaces an existing book instead of duplicating it", async () => {
    const first = makeBook({ id: 3, title: "Before" });
    mockInvoke({ ...emptyLibrary, list_books: [first] });
    const { result } = renderHook(() => useLibraryData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act_emit(makeBook({ id: 3, title: "After", coverPath: "/covers/y.png" }));

    await waitFor(() => expect(result.current.books[0]).toMatchObject({ id: 3, title: "After" }));
    expect(result.current.books).toHaveLength(1);
  });

  it("appends streamed books unsorted and reconciles title order on refresh", async () => {
    mockInvoke(emptyLibrary);
    const { result } = renderHook(() => useLibraryData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act_emit(makeBook({ id: 1, title: "Zeta" }));
    act_emit(makeBook({ id: 2, title: "Alpha" }));

    // Streaming order is append order — O(1) patches, no per-event sort.
    await waitFor(() => expect(result.current.books).toHaveLength(2));
    expect(result.current.books.map((b) => b.title)).toEqual(["Zeta", "Alpha"]);

    // The completing import refresh re-fetches; the backend sorts.
    mockInvoke({
      ...emptyLibrary,
      list_books: [makeBook({ id: 2, title: "Alpha" }), makeBook({ id: 1, title: "Zeta" })],
    });
    await act(() => result.current.refresh());
    expect(result.current.books.map((b) => b.title)).toEqual(["Alpha", "Zeta"]);
  });
});

describe("useLibraryData library-changed synchronization", () => {
  it("patches a book pushed by the filesystem watcher", async () => {
    const first = makeBook({ id: 3, title: "Before" });
    mockInvoke({ ...emptyLibrary, list_books: [first] });
    const { result } = renderHook(() => useLibraryData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      emitBridgeEvent("library-changed", {
        kind: "changed",
        book: makeBook({ id: 3, title: "After", available: true }),
      });
    });

    await waitFor(() => expect(result.current.books[0]).toMatchObject({ id: 3, title: "After" }));
    expect(result.current.books).toHaveLength(1);
  });

  it("marks a book unavailable when its file disappears", async () => {
    const book = makeBook({ id: 5, title: "Vanishing", available: true });
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [book],
    });
    const { result } = renderHook(() => useLibraryData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      emitBridgeEvent("library-changed", {
        kind: "changed",
        book: makeBook({ id: 5, title: "Vanishing", available: false }),
      });
    });

    await waitFor(() => expect(result.current.books[0]).toMatchObject({ id: 5, available: false }));
    // The row stays: metadata, collections, and progress survive.
    expect(result.current.books).toHaveLength(1);
    expect(result.current.stats?.bookCount).toBe(1);
  });

  it("drops a removed book from the list and the stats", async () => {
    const book = makeBook({ id: 9, title: "Removed Book" });
    mockInvoke({ ...emptyLibrary, list_books: [book] });
    const { result } = renderHook(() => useLibraryData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      emitBridgeEvent("library-changed", { kind: "removed", bookId: 9 });
    });

    await waitFor(() => expect(result.current.books).toHaveLength(0));
    expect(result.current.stats?.bookCount).toBe(0);
  });

  it("reflects reading progress saved by the reader", async () => {
    // Regression (issue #10): progress saves used to leave the library
    // stale until a restart. The backend now pushes the updated book over
    // `library-changed`, so the saved percent shows up live.
    mockInvoke({
      ...emptyLibrary,
      list_books: [makeBook({ id: 4, title: "Slow", progressPercent: null })],
    });
    const { result } = renderHook(() => useLibraryData());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.books[0]).toMatchObject({ id: 4, progressPercent: null });

    act(() => {
      emitBridgeEvent("library-changed", {
        kind: "changed",
        book: makeBook({ id: 4, title: "Slow", progressPercent: 37.5 }),
      });
    });

    await waitFor(() =>
      expect(result.current.books[0]).toMatchObject({ id: 4, progressPercent: 37.5 }),
    );
    expect(result.current.books).toHaveLength(1);
  });
});

describe("useLibraryData post-import refresh", () => {
  it("a completing import refresh wins over events still in the flush window", async () => {
    mockInvoke(emptyLibrary);
    const { result } = renderHook(() => useLibraryData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // A watched-folder import streams every book while the location row is
    // still absent, so the event payloads truthfully say loose at emit time.
    // The first batch lands before the import completes.
    act_emit(makeBook({ id: 1, title: "Early Book", loose: true }));
    await waitFor(() => expect(result.current.books).toHaveLength(1));

    // The final batch is still inside the flush window when the completing
    // refresh fetches the reconciled truth: the folder now owns both books.
    act_emit(makeBook({ id: 2, title: "Late Book", loose: true }));
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [
        makeBook({ id: 1, title: "Early Book", loose: false }),
        makeBook({ id: 2, title: "Late Book", loose: false }),
      ],
    });
    await act(() => result.current.refresh());
    expect(result.current.books.every((book) => !book.loose)).toBe(true);

    // The buffered batch must not overwrite the fetched rows afterwards.
    await act(() => new Promise((resolve) => setTimeout(resolve, EVENT_FLUSH_MS + 50)));
    expect(result.current.books.find((book) => book.id === 2)?.loose).toBe(false);
  });
});

function act_emit(book: ReturnType<typeof makeBook>): void {
  // The sidecar batches persisted books into one event (issue #61).
  act(() => {
    emitBridgeEvent("import-progress", { books: [book] });
  });
}
