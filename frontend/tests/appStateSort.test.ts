import { describe, expect, it } from "vite-plus/test";
import { appStateReducer, initialAppState, sortForPlace } from "@/state/appState";

describe("appStateReducer sort preferences", () => {
  it("starts with no explicit sort, so each place uses its default", () => {
    expect(initialAppState.sortByPlace).toEqual({});
    expect(sortForPlace(initialAppState.section, initialAppState.sortByPlace)).toBe("date-added");
  });

  it("remembers a sort per place and falls back to each place's default", () => {
    const sorted = appStateReducer(initialAppState, { type: "set-library-sort", sort: "author" });
    expect(sorted.sortByPlace).toEqual({ "smart:all-books": "author" });

    const switched = appStateReducer(sorted, {
      type: "select-section",
      section: { kind: "smart", id: "recently-added" },
    });
    expect(sortForPlace(switched.section, switched.sortByPlace)).toBe("date-added");

    const back = appStateReducer(switched, {
      type: "select-section",
      section: { kind: "smart", id: "all-books" },
    });
    expect(sortForPlace(back.section, back.sortByPlace)).toBe("author");
  });

  it("set-library-sort stores the choice for the active place and is a no-op when unchanged", () => {
    const sorted = appStateReducer(initialAppState, { type: "set-library-sort", sort: "author" });
    expect(sorted.sortByPlace).toEqual({ "smart:all-books": "author" });
    expect(appStateReducer(sorted, { type: "set-library-sort", sort: "author" })).toBe(sorted);
    // Choosing the default is still an explicit choice for this place.
    const defaulted = appStateReducer(initialAppState, {
      type: "set-library-sort",
      sort: "date-added",
    });
    expect(defaulted.sortByPlace).toEqual({ "smart:all-books": "date-added" });
  });

  it("remembers a sort for each collection place separately", () => {
    const first = appStateReducer(
      { ...initialAppState, section: { kind: "collection", ids: [7] } },
      { type: "set-library-sort", sort: "title" },
    );
    expect(first.sortByPlace).toEqual({ "collection:7": "title" });
    expect(sortForPlace({ kind: "collection", ids: [8] }, first.sortByPlace)).toBe("date-added");
    expect(sortForPlace({ kind: "collection", ids: [7] }, first.sortByPlace)).toBe("title");

    // A multi-selection is its own place, regardless of id order.
    const multi = appStateReducer(
      { ...initialAppState, section: { kind: "collection", ids: [8, 7] } },
      { type: "set-library-sort", sort: "author" },
    );
    expect(sortForPlace({ kind: "collection", ids: [7, 8] }, multi.sortByPlace)).toBe("author");
  });
});
