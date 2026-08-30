import { describe, expect, it } from "vitest";
import { appStateReducer, initialAppState, sameSection } from "@/state/appState";

describe("appStateReducer", () => {
  it("selecting a section returns to the library view", () => {
    const state = appStateReducer(
      { view: "detail", section: { kind: "smart", id: "all-books" }, selectedBookId: 7 },
      { type: "select-section", section: { kind: "smart", id: "pdfs" } },
    );
    expect(state).toEqual({
      view: "library",
      section: { kind: "smart", id: "pdfs" },
      selectedBookId: 7,
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
    });
  });

  it("opening the reader selects the book", () => {
    const state = appStateReducer(initialAppState, { type: "open-reader", bookId: 5 });
    expect(state.view).toBe("reader");
    expect(state.selectedBookId).toBe(5);
  });

  it("returning to the library keeps section and selection", () => {
    const state = appStateReducer(
      { view: "reader", section: { kind: "collection", id: 2 }, selectedBookId: 9 },
      { type: "return-to-library" },
    );
    expect(state).toEqual({
      view: "library",
      section: { kind: "collection", id: 2 },
      selectedBookId: 9,
    });
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
