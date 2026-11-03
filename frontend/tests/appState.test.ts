import { describe, expect, it } from "vite-plus/test";
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
        formatFilter: ["pdf"],
        sort: "section-order",
        settingsOpen: false,
        collectionAnchorId: null,
      },
      { type: "select-section", section: { kind: "smart", id: "recently-added" } },
    );
    expect(state).toEqual({
      view: "library",
      section: { kind: "smart", id: "recently-added" },
      selectedBookId: 7,
      selectedBookIds: [],
      selectionAnchorId: null,
      libraryQuery: "",
      // The format filter composes with every section, so it is not cleared.
      formatFilter: ["pdf"],
      sort: "section-order",
      settingsOpen: false,
      collectionAnchorId: null,
    });
  });

  it("starts with Section order", () => {
    expect(initialAppState.sort).toBe("section-order");
  });

  it("keeps the sort choice when the place changes", () => {
    const sorted = { ...initialAppState, sort: "author" as const };
    const state = appStateReducer(sorted, {
      type: "select-section",
      section: { kind: "collection", ids: [3] },
    });
    expect(state.sort).toBe("author");
  });

  it("set-library-sort stores the choice and is a no-op when unchanged", () => {
    const sorted = appStateReducer(initialAppState, { type: "set-library-sort", sort: "author" });
    expect(sorted.sort).toBe("author");
    expect(appStateReducer(sorted, { type: "set-library-sort", sort: "author" })).toBe(sorted);
  });

  it("opens and closes the settings window without changing the view", () => {
    const opened = appStateReducer(initialAppState, { type: "open-settings" });
    expect(opened.settingsOpen).toBe(true);
    expect(opened.view).toBe("library");
    expect(opened.section).toEqual(initialAppState.section);

    const closed = appStateReducer(opened, { type: "close-settings" });
    expect(closed.settingsOpen).toBe(false);
    // Repeating either direction is a no-op that keeps the state object.
    expect(appStateReducer(opened, { type: "open-settings" })).toBe(opened);
    expect(appStateReducer(closed, { type: "close-settings" })).toBe(closed);
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
      readerTargetAnnotationId: null,
      libraryQuery: "",
      formatFilter: [],
      sort: "section-order",
      settingsOpen: false,
      collectionAnchorId: null,
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
    expect(state.readerTargetAnnotationId).toBeNull();
  });

  it("opening the reader from a highlight carries its target until consumed", () => {
    const opened = appStateReducer(initialAppState, {
      type: "open-reader",
      bookId: 5,
      annotationId: 12,
    });
    expect(opened.readerTargetAnnotationId).toBe(12);

    const consumed = appStateReducer(opened, { type: "reader-target-consumed" });
    expect(consumed.readerTargetAnnotationId).toBeNull();
    // Consuming twice is a no-op, like any already-cleared target.
    expect(appStateReducer(consumed, { type: "reader-target-consumed" })).toBe(consumed);
  });

  it("a plain reader open clears a stale highlight target", () => {
    const state = appStateReducer(
      { ...initialAppState, readerTargetAnnotationId: 12 },
      { type: "open-reader", bookId: 5 },
    );
    expect(state.readerTargetAnnotationId).toBeNull();
  });

  it("returning to the library keeps section and selection", () => {
    const state = appStateReducer(
      {
        view: "reader",
        section: { kind: "collection", ids: [2] },
        selectedBookId: 9,
        selectedBookIds: [9],
        selectionAnchorId: 9,
        libraryQuery: "",
        formatFilter: [],
        sort: "section-order",
        settingsOpen: false,
        collectionAnchorId: 2,
      },
      { type: "return-to-library" },
    );
    expect(state).toEqual({
      view: "library",
      section: { kind: "collection", ids: [2] },
      selectedBookId: 9,
      selectedBookIds: [9],
      selectionAnchorId: 9,
      libraryQuery: "",
      formatFilter: [],
      sort: "section-order",
      settingsOpen: false,
      collectionAnchorId: 2,
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

  it("a right-click takeover replaces the selection but leaves the anchor", () => {
    const state = appStateReducer(withSelection([2, 5], 2), {
      type: "library-context-select",
      bookId: 7,
    });
    expect(state.selectedBookIds).toEqual([7]);
    expect(state.selectionAnchorId).toBe(2);
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

  it("sets the format filter and returns the same object when it did not change", () => {
    const filtered = appStateReducer(initialAppState, {
      type: "set-format-filter",
      formats: ["pdf"],
    });
    expect(filtered.formatFilter).toEqual(["pdf"]);
    expect(appStateReducer(filtered, { type: "set-format-filter", formats: ["pdf"] })).toBe(
      filtered,
    );
  });

  it("an empty format set means no restriction, not no books", () => {
    const filtered = appStateReducer(initialAppState, {
      type: "set-format-filter",
      formats: ["epub"],
    });
    expect(
      appStateReducer(filtered, { type: "set-format-filter", formats: [] }).formatFilter,
    ).toEqual([]);
  });
});

describe("appStateReducer collection selection", () => {
  /** Sidebar order (Pinned Collections, then Unpinned Collections). */
  const visibleIds = [5, 3, 8, 2];

  it("a plain click replaces the place with that collection and anchors it", () => {
    const state = appStateReducer(
      {
        ...initialAppState,
        section: { kind: "collection", ids: [5, 3] },
        collectionAnchorId: 3,
        libraryQuery: "meridian",
        selectedBookIds: [1],
        selectionAnchorId: 1,
      },
      { type: "select-collection", collectionId: 8, mode: "replace", visibleIds },
    );
    expect(state.section).toEqual({ kind: "collection", ids: [8] });
    expect(state.collectionAnchorId).toBe(8);
    // A place change returns to the library and clears the scoped state.
    expect(state.view).toBe("library");
    expect(state.libraryQuery).toBe("");
    expect(state.selectedBookIds).toEqual([]);
    expect(state.selectionAnchorId).toBeNull();
  });

  it("plain-clicking the sole selected collection leaves it selected", () => {
    const state = appStateReducer(
      {
        ...initialAppState,
        section: { kind: "collection", ids: [5] },
        collectionAnchorId: 5,
      },
      { type: "select-collection", collectionId: 5, mode: "replace", visibleIds },
    );
    expect(state.section).toEqual({ kind: "collection", ids: [5] });
    expect(state.collectionAnchorId).toBe(5);
  });

  it("ctrl+click adds a collection in sidebar order and moves the anchor", () => {
    const state = appStateReducer(
      {
        ...initialAppState,
        section: { kind: "collection", ids: [8] },
        collectionAnchorId: 8,
      },
      { type: "select-collection", collectionId: 5, mode: "toggle", visibleIds },
    );
    expect(state.section).toEqual({ kind: "collection", ids: [5, 8] });
    expect(state.collectionAnchorId).toBe(5);
  });

  it("ctrl+click removes a selected collection and still moves the anchor", () => {
    const state = appStateReducer(
      {
        ...initialAppState,
        section: { kind: "collection", ids: [5, 8] },
        collectionAnchorId: 5,
      },
      { type: "select-collection", collectionId: 5, mode: "toggle", visibleIds },
    );
    expect(state.section).toEqual({ kind: "collection", ids: [8] });
    expect(state.collectionAnchorId).toBe(5);
  });

  it("ctrl+clicking the last selected collection falls back to All Books", () => {
    const state = appStateReducer(
      {
        ...initialAppState,
        section: { kind: "collection", ids: [5] },
        collectionAnchorId: 5,
      },
      { type: "select-collection", collectionId: 5, mode: "toggle", visibleIds },
    );
    expect(state.section).toEqual({ kind: "smart", id: "all-books" });
    expect(state.collectionAnchorId).toBeNull();
  });

  it("ctrl+click from a smart section starts a collection place", () => {
    const state = appStateReducer(initialAppState, {
      type: "select-collection",
      collectionId: 3,
      mode: "toggle",
      visibleIds,
    });
    expect(state.section).toEqual({ kind: "collection", ids: [3] });
    expect(state.collectionAnchorId).toBe(3);
  });

  it("shift+click selects the visible range across the whole sidebar order", () => {
    // The visible list runs across the Pinned/Unpinned boundary ticket 4 adds.
    const state = appStateReducer(
      {
        ...initialAppState,
        section: { kind: "collection", ids: [5] },
        collectionAnchorId: 5,
      },
      { type: "select-collection", collectionId: 8, mode: "range", visibleIds },
    );
    expect(state.section).toEqual({ kind: "collection", ids: [5, 3, 8] });
    // Shift-click never moves the anchor.
    expect(state.collectionAnchorId).toBe(5);
  });

  it("shift+click takes the same range when the target precedes the anchor", () => {
    const state = appStateReducer(
      {
        ...initialAppState,
        section: { kind: "collection", ids: [8] },
        collectionAnchorId: 8,
      },
      { type: "select-collection", collectionId: 3, mode: "range", visibleIds },
    );
    expect(state.section).toEqual({ kind: "collection", ids: [3, 8] });
    expect(state.collectionAnchorId).toBe(8);
  });

  it("shift+click falls back to the target when the anchor is not visible", () => {
    const state = appStateReducer(
      {
        ...initialAppState,
        section: { kind: "collection", ids: [99] },
        collectionAnchorId: 99,
      },
      { type: "select-collection", collectionId: 8, mode: "range", visibleIds },
    );
    expect(state.section).toEqual({ kind: "collection", ids: [8] });
    expect(state.collectionAnchorId).toBe(99);
  });

  it("selecting a smart section clears the collection selection and anchor", () => {
    const state = appStateReducer(
      {
        ...initialAppState,
        section: { kind: "collection", ids: [5, 3] },
        collectionAnchorId: 3,
      },
      { type: "select-section", section: { kind: "smart", id: "all-books" } },
    );
    expect(state.section).toEqual({ kind: "smart", id: "all-books" });
    expect(state.collectionAnchorId).toBeNull();
  });

  it("selecting a collection section directly anchors its last id", () => {
    const state = appStateReducer(initialAppState, {
      type: "select-section",
      section: { kind: "collection", ids: [7] },
    });
    expect(state.section).toEqual({ kind: "collection", ids: [7] });
    expect(state.collectionAnchorId).toBe(7);
  });
});

describe("appStateReducer collection deletion", () => {
  it("removes only the deleted id from a multi-selection", () => {
    const state = appStateReducer(
      {
        ...initialAppState,
        section: { kind: "collection", ids: [5, 3, 8] },
        collectionAnchorId: 5,
        libraryQuery: "meridian",
        selectedBookIds: [1],
        selectionAnchorId: 1,
      },
      { type: "collection-deleted", collectionId: 3 },
    );
    expect(state.section).toEqual({ kind: "collection", ids: [5, 8] });
    expect(state.collectionAnchorId).toBe(5);
    // A place change clears the section-scoped search and book selection.
    expect(state.libraryQuery).toBe("");
    expect(state.selectedBookIds).toEqual([]);
    expect(state.selectionAnchorId).toBeNull();
  });

  it("falls back to All Books when the last selected collection is deleted", () => {
    const state = appStateReducer(
      {
        ...initialAppState,
        section: { kind: "collection", ids: [5] },
        collectionAnchorId: 5,
      },
      { type: "collection-deleted", collectionId: 5 },
    );
    expect(state.section).toEqual({ kind: "smart", id: "all-books" });
    expect(state.collectionAnchorId).toBeNull();
  });

  it("moves the anchor to the last remaining collection when it was deleted", () => {
    const state = appStateReducer(
      {
        ...initialAppState,
        section: { kind: "collection", ids: [5, 3, 8] },
        collectionAnchorId: 3,
      },
      { type: "collection-deleted", collectionId: 3 },
    );
    expect(state.section).toEqual({ kind: "collection", ids: [5, 8] });
    expect(state.collectionAnchorId).toBe(8);
  });

  it("leaves the selection untouched when an unselected collection is deleted", () => {
    const before: AppState = {
      ...initialAppState,
      section: { kind: "collection", ids: [5, 3] },
      collectionAnchorId: 5,
    };
    expect(appStateReducer(before, { type: "collection-deleted", collectionId: 8 })).toBe(before);
    expect(appStateReducer(initialAppState, { type: "collection-deleted", collectionId: 8 })).toBe(
      initialAppState,
    );
  });
});

describe("sameSection", () => {
  it("matches smart sections by id", () => {
    expect(
      sameSection({ kind: "smart", id: "all-books" }, { kind: "smart", id: "all-books" }),
    ).toBe(true);
    expect(
      sameSection({ kind: "smart", id: "all-books" }, { kind: "smart", id: "recently-added" }),
    ).toBe(false);
  });

  it("never matches across kinds", () => {
    expect(sameSection({ kind: "smart", id: "all-books" }, { kind: "reading-history" })).toBe(
      false,
    );
    expect(sameSection({ kind: "collection", ids: [1] }, { kind: "reading-history" })).toBe(false);
  });

  it("matches collection places by their selected ids in order", () => {
    expect(
      sameSection({ kind: "collection", ids: [5, 3] }, { kind: "collection", ids: [5, 3] }),
    ).toBe(true);
    expect(
      sameSection({ kind: "collection", ids: [5, 3] }, { kind: "collection", ids: [3, 5] }),
    ).toBe(false);
    expect(sameSection({ kind: "collection", ids: [5] }, { kind: "collection", ids: [5, 3] })).toBe(
      false,
    );
  });
});
