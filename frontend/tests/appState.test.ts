import { describe, expect, it } from "vite-plus/test";
import { appStateReducer, initialAppState, sameSection } from "@/state/appState";

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
        sortByPlace: {},
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
      sortByPlace: {},
      settingsOpen: false,
      collectionAnchorId: null,
    });
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
      sortByPlace: {},
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
        sortByPlace: {},
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
      sortByPlace: {},
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
