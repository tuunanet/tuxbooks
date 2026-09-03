import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLibraryData } from "@/hooks/useLibrary";
import { makeBook } from "./factories";
import { emitTauriEvent, mockInvoke } from "./mocks/tauri";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

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

    await waitFor(() => expect(result.current.books).toHaveLength(1));
    expect(result.current.books[0]).toMatchObject({ id: 3, title: "After" });
  });

  it("keeps the list ordered by title as books stream in", async () => {
    mockInvoke(emptyLibrary);
    const { result } = renderHook(() => useLibraryData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act_emit(makeBook({ id: 1, title: "Zeta" }));
    act_emit(makeBook({ id: 2, title: "Alpha" }));

    await waitFor(() =>
      expect(result.current.books.map((b) => b.title)).toEqual(["Alpha", "Zeta"]),
    );
  });
});

describe("useLibraryData library-changed synchronization", () => {
  it("patches a book pushed by the filesystem watcher", async () => {
    const first = makeBook({ id: 3, title: "Before" });
    mockInvoke({ ...emptyLibrary, list_books: [first] });
    const { result } = renderHook(() => useLibraryData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    act(() => {
      emitTauriEvent("library-changed", {
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
      emitTauriEvent("library-changed", {
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
      emitTauriEvent("library-changed", { kind: "removed", bookId: 9 });
    });

    await waitFor(() => expect(result.current.books).toHaveLength(0));
    expect(result.current.stats?.bookCount).toBe(0);
  });
});

function act_emit(book: ReturnType<typeof makeBook>): void {
  act(() => {
    emitTauriEvent("import-progress", book);
  });
}
