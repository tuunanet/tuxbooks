import { describe, expect, it } from "vitest";

import {
  appendSearchGroup,
  emptySearchState,
  finishSearchGroup,
} from "@/components/reader/searchModel";
import { jumpToSearchMatch } from "@/components/reader/readerModel";
import type { ReaderSearchGroup } from "@/components/reader/searchModel";
import { sameSection, type LibrarySection, type SmartSectionId } from "@/state/appState";

describe("searchModel stream accumulation", () => {
  it("starts running with no groups", () => {
    const state = emptySearchState(7, "needle");
    expect(state.status).toBe("running");
    expect(state.groups).toEqual([]);
    expect(state.totalMatches).toBe(0);
    expect(state.query).toBe("needle");
  });

  it("appends groups and accumulates match counts", () => {
    const group = (n: number): ReaderSearchGroup => ({
      label: `Section ${n}`,
      matches: [{ locator: null, page: n, excerpt: { pre: "", match: `m${n}`, post: "" } }],
    });
    let state = emptySearchState(7, "needle");
    state = appendSearchGroup(state, 7, group(1));
    state = appendSearchGroup(state, 7, group(2));
    expect(state.groups).toHaveLength(2);
    expect(state.totalMatches).toBe(2);
  });

  it("ignores groups and completion from another book", () => {
    let state = emptySearchState(7, "needle");
    const group: ReaderSearchGroup = {
      label: "Section",
      matches: [
        { locator: "epubcfi(/6/2)", page: null, excerpt: { pre: "", match: "m", post: "" } },
      ],
    };
    state = appendSearchGroup(state, 99, group);
    expect(state.groups).toHaveLength(0);
    state = finishSearchGroup(state, 99);
    expect(state.status).toBe("running");
    state = finishSearchGroup(state, 7);
    expect(state.status).toBe("done");
  });
});

describe("jumpToSearchMatch", () => {
  it("prefers the locator and falls back to the PDF page", () => {
    const locatorJump = jumpToSearchMatch({
      locator: "epubcfi(/6/2!/4/2)",
      page: null,
      excerpt: { pre: "", match: "m", post: "" },
    });
    expect(locatorJump?.format).toBe("epub");
    const pageJump = jumpToSearchMatch({
      locator: null,
      page: 3,
      excerpt: { pre: "", match: "m", post: "" },
    });
    expect(pageJump?.format).toBe("pdf");
    expect(
      jumpToSearchMatch({ locator: null, page: null, excerpt: { pre: "", match: "m", post: "" } }),
    ).toBeNull();
  });
});

describe("sameSection", () => {
  const smart = (id: SmartSectionId): LibrarySection => ({ kind: "smart", id });
  const collection = (id: number): LibrarySection => ({ kind: "collection", id });
  it("distinguishes kinds and smart/collection identities", () => {
    expect(sameSection(smart("all-books"), smart("all-books"))).toBe(true);
    expect(sameSection(smart("all-books"), smart("epubs"))).toBe(false);
    expect(sameSection(collection(1), collection(1))).toBe(true);
    expect(sameSection(collection(1), collection(2))).toBe(false);
    expect(sameSection(smart("all-books"), collection(1))).toBe(false);
    expect(sameSection({ kind: "settings" }, { kind: "settings" })).toBe(true);
  });
});
