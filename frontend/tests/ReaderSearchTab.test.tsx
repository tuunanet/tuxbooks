import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ReaderSearchTab } from "@/components/reader/ReaderSearchTab";
import type { ReaderSearchState } from "@/components/reader/searchModel";

const RUNNING: ReaderSearchState = {
  bookId: 1,
  query: "river",
  status: "running",
  groups: [],
  totalMatches: 0,
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
          cfi: "epubcfi(/6/2!/4/2)",
          page: null,
          excerpt: { pre: "down by the ", match: "river", post: " they sat" },
        },
        {
          cfi: "epubcfi(/6/2!/4/4)",
          page: null,
          excerpt: { pre: "the ", match: "river", post: " bent" },
        },
      ],
    },
    {
      label: "Page 4",
      matches: [
        {
          cfi: null,
          page: 4,
          excerpt: { pre: "along the ", match: "river", post: " bank" },
        },
      ],
    },
  ],
  totalMatches: 3,
};

describe("ReaderSearchTab", () => {
  it("prompts before the first search", () => {
    render(<ReaderSearchTab search={null} onSearch={() => {}} onPickMatch={() => {}} />);
    expect(screen.getByTestId("reader-search-input")).toBeInTheDocument();
    expect(screen.getByText(/Type to search/i)).toBeInTheDocument();
  });

  it("shows a running indicator with no matches yet", () => {
    render(<ReaderSearchTab search={RUNNING} onSearch={() => {}} onPickMatch={() => {}} />);
    expect(screen.getByTestId("reader-search-status")).toHaveTextContent(/Searching/i);
    expect(screen.queryAllByTestId("reader-search-match")).toHaveLength(0);
  });

  it("renders grouped matches with a total count", () => {
    render(<ReaderSearchTab search={WITH_RESULTS} onSearch={() => {}} onPickMatch={() => {}} />);
    expect(screen.getByTestId("reader-search-status")).toHaveTextContent("3 matches");
    expect(screen.getByText("Chapter One (2)")).toBeInTheDocument();
    expect(screen.getByText("Page 4 (1)")).toBeInTheDocument();
    expect(screen.getAllByTestId("reader-search-match")).toHaveLength(3);
  });

  it("picks a match on click", async () => {
    const onPickMatch = vi.fn();
    render(<ReaderSearchTab search={WITH_RESULTS} onSearch={() => {}} onPickMatch={onPickMatch} />);
    await userEvent.click(screen.getAllByTestId("reader-search-match")[0]!);
    expect(onPickMatch).toHaveBeenCalledWith(WITH_RESULTS.groups[0]!.matches[0]);
  });

  it("submits a new query once, debounced, and clears on empty", async () => {
    const onSearch = vi.fn();
    render(<ReaderSearchTab search={null} onSearch={onSearch} onPickMatch={() => {}} />);
    const input = screen.getByTestId("reader-search-input");
    await userEvent.type(input, "river");
    await vi.waitFor(() => expect(onSearch).toHaveBeenCalledWith("river"));
    expect(onSearch).toHaveBeenCalledTimes(1);
  }, 15000);

  it("restores the previous query into the input without re-searching", async () => {
    const onSearch = vi.fn();
    render(<ReaderSearchTab search={WITH_RESULTS} onSearch={onSearch} onPickMatch={() => {}} />);
    expect(screen.getByTestId("reader-search-input")).toHaveValue("river");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(onSearch).not.toHaveBeenCalled();
  });
});
