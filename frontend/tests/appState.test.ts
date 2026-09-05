import { describe, expect, it } from "vitest";
import { appStateReducer, initialAppState, sameSection } from "@/state/appState";

describe("appStateReducer", () => {
  it("selecting a section returns to the library view", () => {
    const state = appStateReducer(
      {
        view: "detail",
        section: { kind: "smart", id: "all-books" },
        selectedBookId: 7,
        libraryQuery: "meridian",
        metadataEditorBookId: null,
      },
      { type: "select-section", section: { kind: "smart", id: "pdfs" } },
    );
    expect(state).toEqual({
      view: "library",
      section: { kind: "smart", id: "pdfs" },
      selectedBookId: 7,
      libraryQuery: "",
      metadataEditorBookId: null,
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
      libraryQuery: "",
      metadataEditorBookId: null,
    });
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
        metadataEditorBookId: null,
      },
      { type: "return-to-library" },
    );
    expect(state).toEqual({
      view: "library",
      section: { kind: "collection", id: 2 },
      selectedBookId: 9,
      libraryQuery: "",
      metadataEditorBookId: null,
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
    expect(sameSection({ kind: "smart", id: "epubs" }, { kind: "smart", id: "epubs" })).toBe(true);
    expect(sameSection({ kind: "smart", id: "epubs" }, { kind: "smart", id: "pdfs" })).toBe(false);
  });

  it("never matches across kinds", () => {
    expect(sameSection({ kind: "smart", id: "epubs" }, { kind: "settings" })).toBe(false);
    expect(sameSection({ kind: "collection", id: 1 }, { kind: "settings" })).toBe(false);
  });
});
