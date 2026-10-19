import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ReaderSearchOverlay } from "@/components/reader/ReaderSearchOverlay";
import type { ReaderSearchState } from "@/components/reader/searchModel";

const RUNNING: ReaderSearchState = {
  bookId: 1,
  query: "river",
  status: "running",
  groups: [],
  totalMatches: 0,
  truncated: false,
};

const WITH_RESULTS: ReaderSearchState = {
  bookId: 1,
  query: "river",
  status: "done",
  groups: [
    {
      label: "Chapter One",
      matches: [
        {
          locator: "epubcfi(/6/2!/4/2)",
          page: null,
          excerpt: { pre: "down by the ", match: "river", post: " they sat" },
        },
        {
          locator: "epubcfi(/6/2!/4/4)",
          page: null,
          excerpt: { pre: "the ", match: "river", post: " bent" },
        },
      ],
    },
    {
      label: "Page 4",
      matches: [
        {
          locator: null,
          page: 4,
          excerpt: { pre: "along the ", match: "river", post: " bank" },
        },
      ],
    },
  ],
  totalMatches: 3,
  truncated: false,
};

const NO_RESULTS: ReaderSearchState = {
  bookId: 1,
  query: "river",
  status: "done",
  groups: [],
  totalMatches: 0,
  truncated: false,
};

function renderOverlay(search: ReaderSearchState | null, open = true) {
  const onOpenChange = vi.fn();
  const onSearch = vi.fn();
  const onPickMatch = vi.fn();
  render(
    <ReaderSearchOverlay
      open={open}
      onOpenChange={onOpenChange}
      search={search}
      onSearch={onSearch}
      onPickMatch={onPickMatch}
      theme="default"
    />,
  );
  return { onOpenChange, onSearch, onPickMatch };
}

describe("ReaderSearchOverlay", () => {
  it("prompts before the first search and focuses the field", () => {
    renderOverlay(null);
    const input = screen.getByTestId("reader-search-input");
    expect(input).toHaveFocus();
    expect(screen.getByTestId("reader-search-results")).toHaveTextContent(
      "Search the text of this book.",
    );
    expect(screen.getByTestId("reader-search-status")).toHaveTextContent(/Type to search/i);
  });

  it("shows a running indicator with no matches yet", () => {
    renderOverlay(RUNNING);
    expect(screen.getByTestId("reader-search-status")).toHaveTextContent(/Searching/i);
    expect(screen.queryAllByTestId("reader-search-match")).toHaveLength(0);
  });

  it("renders one document-order list with locations and a total count", () => {
    renderOverlay(WITH_RESULTS);
    expect(screen.getByTestId("reader-search-status")).toHaveTextContent("3 matches");
    expect(screen.getAllByTestId("reader-search-match")).toHaveLength(3);
    expect(screen.getAllByText("Chapter One")).toHaveLength(2);
    expect(screen.getByText("Page 4")).toBeInTheDocument();
    expect(screen.getAllByTestId("reader-search-match")[0]).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("moves the active result with the arrow keys and picks it with Enter", () => {
    const { onOpenChange, onPickMatch } = renderOverlay(WITH_RESULTS);
    const input = screen.getByTestId("reader-search-input");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPickMatch).toHaveBeenCalledWith(WITH_RESULTS.groups[0]!.matches[1]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("picks a match on click and closes the overlay", async () => {
    const { onOpenChange, onPickMatch } = renderOverlay(WITH_RESULTS);
    await userEvent.click(screen.getAllByTestId("reader-search-match")[0]!);
    expect(onPickMatch).toHaveBeenCalledWith(WITH_RESULTS.groups[0]!.matches[0]);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("clears stale results immediately and searches once after the debounce", async () => {
    const { onSearch } = renderOverlay(null);
    await userEvent.type(screen.getByTestId("reader-search-input"), "river");
    expect(onSearch).toHaveBeenCalledWith("");
    await vi.waitFor(() => expect(onSearch).toHaveBeenLastCalledWith("river"));
  }, 15000);

  it("restores the previous query without re-searching", async () => {
    const { onSearch } = renderOverlay(WITH_RESULTS);
    expect(screen.getByTestId("reader-search-input")).toHaveValue("river");
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(onSearch).not.toHaveBeenCalled();
  });

  it("reports no matches for a finished empty search", () => {
    renderOverlay(NO_RESULTS);
    expect(screen.getByText(/No matches for “river”/)).toBeInTheDocument();
    expect(screen.getByTestId("reader-search-status")).toHaveTextContent("No matches");
  });

  it("tells the reader when the engine stopped at its match limit", () => {
    renderOverlay({
      ...WITH_RESULTS,
      totalMatches: 500,
      truncated: true,
      groups: [WITH_RESULTS.groups[0]!],
    });
    expect(screen.getByTestId("reader-search-status")).toHaveTextContent(
      "500 matches · search limit reached",
    );
  });
});
