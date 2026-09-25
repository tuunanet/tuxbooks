import { describe, expect, it } from "vitest";
import { appStateReducer, initialAppState, sameSection, type AppState } from "@/state/appState";

/** A library state with a multi-selection in place. */
function withSelection(selectedBookIds: number[], selectionAnchorId: number | null): AppState {
  return { ...initialAppState, selectedBookIds, selectionAnchorId };
}

describe("appStateReducer", () => {
  it("selecting a section returns to the library view and clears the selection", () => {
    const state = appStateReducer(
      {
        view: "detail",
        section: { kind: "smart", id: "all-books" },
        selectedBookId: 7,
        selectedBookIds: [1, 3],
        selectionAnchorId: 1,
        libraryQuery: "meridian",
      },
      { type: "select-section", section: { kind: "smart", id: "pdfs" } },
    );
    expect(state).toEqual({
      view: "library",
      section: { kind: "smart", id: "pdfs" },
      selectedBookId: 7,
      selectedBookIds: [],
      selectionAnchorId: null,
      libraryQuery: "",
    });
  });

  it("selecting settings returns to the library view", () => {
    const state = appStateReducer(initialAppState, {
      type: "select-section",
      section: { kind: "settings" },
    });
    expect(state.view).toBe("library");
    expect(state.section).toEqual({ kind: "settings" });
  });

  it("opening book detail keeps the section and selects the book", () => {
    const state = appStateReducer(initialAppState, { type: "open-book-detail", bookId: 3 });
    expect(state).toEqual({
      view: "detail",
      section: { kind: "smart", id: "all-books" },
      selectedBookId: 3,
      selectedBookIds: [],
      selectionAnchorId: null,
      detailTab: "overview",
      libraryQuery: "",
    });
  });

  it("selects the metadata section of the detail view", () => {
    const state = appStateReducer(initialAppState, {
      type: "select-detail-tab",
      tab: "metadata",
    });
    expect(state.detailTab).toBe("metadata");
    expect(state.view).toBe("library");
  });

  it("opening the reader selects the book", () => {
    const state = appStateReducer(initialAppState, { type: "open-reader", bookId: 5 });
    expect(state.view).toBe("reader");
    expect(state.selectedBookId).toBe(5);
  });

  it("returning to the library keeps section and selection", () => {
    const state = appStateReducer(
      {
        view: "reader",
        section: { kind: "collection", id: 2 },
        selectedBookId: 9,
        libraryQuery: "",
      },
      { type: "return-to-library" },
    );
    expect(state).toEqual({
      view: "library",
      section: { kind: "collection", id: 2 },
      selectedBookId: 9,
      libraryQuery: "",
    });
  });

  it("set-library-query stores the search text", () => {
    const state = appStateReducer(initialAppState, {
      type: "set-library-query",
      query: "meridian",
    });
    expect(state.libraryQuery).toBe("meridian");
  });

  it("set-library-query is a no-op for an unchanged query", () => {
    const state = { ...initialAppState, libraryQuery: "meridian" };
    expect(appStateReducer(state, { type: "set-library-query", query: "meridian" })).toBe(state);
  });
});

describe("appStateReducer library selection", () => {
  it("a plain click selects only that book and anchors the range there", () => {
    const state = appStateReducer(withSelection([2, 5], 2), { type: "library-select", bookId: 7 });
    expect(state.selectedBookIds).toEqual([7]);
    expect(state.selectionAnchorId).toBe(7);
  });

  it("ctrl+click adds an unselected book and moves the anchor", () => {
    const state = appStateReducer(withSelection([2], 2), {
      type: "library-toggle-select",
      bookId: 5,
    });
    expect(state.selectedBookIds).toEqual([2, 5]);
    expect(state.selectionAnchorId).toBe(5);
  });

  it("ctrl+click drops a selected book and still moves the anchor", () => {
    const state = appStateReducer(withSelection([2, 5], 2), {
      type: "library-toggle-select",
      bookId: 5,
    });
    expect(state.selectedBookIds).toEqual([2]);
    expect(state.selectionAnchorId).toBe(5);
  });

  it("shift+click replaces the selection with the range over the visible order", () => {
    // On screen: 5, 3, 1, 4. The range runs 5..1 in that order and drops the
    // selected book (9) that the filter hides.
    const state = appStateReducer(withSelection([5, 9], 5), {
      type: "library-range-select",
      bookId: 1,
      visibleIds: [5, 3, 1, 4],
    });
    expect(state.selectedBookIds).toEqual([5, 3, 1]);
    expect(state.selectionAnchorId).toBe(5);
  });

  it("shift+click selects the same range when the target precedes the anchor", () => {
    const state = appStateReducer(withSelection([1], 1), {
      type: "library-range-select",
      bookId: 5,
      visibleIds: [5, 3, 1, 4],
    });
    expect(state.selectedBookIds).toEqual([5, 3, 1]);
    expect(state.selectionAnchorId).toBe(1);
  });

  it("shift+click falls back to the target when the anchor is filtered out", () => {
    const state = appStateReducer(withSelection([9], 9), {
      type: "library-range-select",
      bookId: 3,
      visibleIds: [5, 3, 1, 4],
    });
    expect(state.selectedBookIds).toEqual([3]);
    // The anchor only ever moves on a plain or Ctrl click.
    expect(state.selectionAnchorId).toBe(9);
  });

  it("shift+click before any plain click selects only the target", () => {
    const state = appStateReducer(initialAppState, {
      type: "library-range-select",
      bookId: 2,
      visibleIds: [1, 2, 3],
    });
    expect(state.selectedBookIds).toEqual([2]);
    expect(state.selectionAnchorId).toBeNull();
  });

  it("keeps the selection when the search query changes", () => {
    const state = appStateReducer(withSelection([1, 4], 1), {
      type: "set-library-query",
      query: "meridian",
    });
    expect(state.selectedBookIds).toEqual([1, 4]);
    expect(state.selectionAnchorId).toBe(1);
  });

  it("clearing drops every selected id and the anchor", () => {
    const state = appStateReducer(withSelection([1, 4], 1), {
      type: "clear-library-selection",
    });
    expect(state.selectedBookIds).toEqual([]);
    expect(state.selectionAnchorId).toBeNull();
  });

  it("clearing an empty selection keeps the same state object", () => {
    expect(appStateReducer(initialAppState, { type: "clear-library-selection" })).toBe(
      initialAppState,
    );
  });
});

describe("sameSection", () => {
  it("matches smart sections by id", () => {
    expect(sameSection({ kind: "smart", id: "epubs" }, { kind: "smart", id: "epubs" })).toBe(true);
    expect(sameSection({ kind: "smart", id: "epubs" }, { kind: "smart", id: "pdfs" })).toBe(false);
  });

  it("never matches across kinds", () => {
    expect(sameSection({ kind: "smart", id: "epubs" }, { kind: "settings" })).toBe(false);
    expect(sameSection({ kind: "collection", id: 1 }, { kind: "settings" })).toBe(false);
  });
});
