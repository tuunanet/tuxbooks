import { describe, expect, it } from "vite-plus/test";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { makeCollection } from "./factories";
import { alpha, beta, renderLibrary, renderShell } from "./libraryViewHelpers";
import { mockInvoke } from "./mocks/bridge";

describe("LibraryView empty states", () => {
  it("offers to clear the format filter when it matches nothing", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [alpha()],
    });

    renderLibrary();

    await userEvent.click(await screen.findByTestId("library-format-filter"));
    await userEvent.click(screen.getByTestId("format-filter-pdf"));
    await userEvent.keyboard("{Escape}");

    expect(await screen.findByTestId("empty-format-filter")).toBeInTheDocument();
    expect(screen.getByTestId("library-stats")).toHaveTextContent("0 books");

    await userEvent.click(screen.getByRole("button", { name: "Clear format filter" }));
    expect(await screen.findByTestId("book-card")).toBeInTheDocument();
  });

  it("shows the empty-section state for a section without books", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [alpha()],
    });

    renderLibrary({ kind: "smart", id: "in-progress" });

    expect(await screen.findByTestId("empty-section")).toBeInTheDocument();
    expect(screen.getByTestId("library-stats")).toHaveTextContent("0 books");
  });

  it("does not blame the filter when every format is ticked", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [alpha()],
    });

    renderLibrary({ kind: "smart", id: "in-progress" });

    await userEvent.click(await screen.findByTestId("library-format-filter"));
    await userEvent.click(screen.getByTestId("format-filter-epub"));
    await userEvent.click(screen.getByTestId("format-filter-pdf"));
    await userEvent.keyboard("{Escape}");

    expect(await screen.findByTestId("empty-section")).toBeInTheDocument();
    expect(screen.queryByTestId("empty-format-filter")).not.toBeInTheDocument();
  });

  it("offers both ways out when a search and a format filter hide everything", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();

    await userEvent.click(await screen.findByTestId("library-format-filter"));
    await userEvent.click(screen.getByTestId("format-filter-pdf"));
    await userEvent.keyboard("{Escape}");
    await userEvent.type(screen.getByTestId("library-search"), "zzz");

    expect(await screen.findByTestId("no-search-results")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear format filter" })).toBeInTheDocument();
  });

  it("keeps the collection explanation when the collection itself is empty", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 1 },
      list_books: [],
    });

    renderLibrary({ kind: "collection", ids: [1] });

    await userEvent.click(await screen.findByTestId("library-format-filter"));
    await userEvent.click(screen.getByTestId("format-filter-pdf"));
    await userEvent.keyboard("{Escape}");

    expect(await screen.findByTestId("empty-collection")).toBeInTheDocument();
    expect(screen.queryByTestId("empty-format-filter")).not.toBeInTheDocument();
  });

  it("shows the empty-collection state for a collection section", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 1 },
      list_books: [],
    });

    renderLibrary({ kind: "collection", ids: [1] });

    expect(await screen.findByTestId("empty-collection")).toBeInTheDocument();
  });

  it("offers All Books when a union of collections has no members", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 2 },
      list_books: [],
      list_collections: [
        makeCollection({ id: 7, name: "Favorites" }),
        makeCollection({ id: 8, name: "Research" }),
      ],
    });

    renderShell({ kind: "collection", ids: [7, 8] });

    expect(await screen.findByTestId("empty-multi-collection")).toBeInTheDocument();
    expect(screen.getByText("No books in these collections")).toBeInTheDocument();
    expect(screen.queryByTestId("empty-collection")).not.toBeInTheDocument();

    await userEvent.click(
      within(screen.getByTestId("empty-multi-collection")).getByRole("button", {
        name: "All Books",
      }),
    );
    expect(await screen.findByTestId("empty-library")).toBeInTheDocument();
  });

  it("names the filter when a collection's members are hidden", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 1 },
      list_books: [alpha()],
      list_collections: [makeCollection({ id: 7, name: "Favorites", bookIds: [1] })],
    });

    renderLibrary({ kind: "collection", ids: [7] });

    await userEvent.click(await screen.findByTestId("library-format-filter"));
    await userEvent.click(screen.getByTestId("format-filter-pdf"));
    await userEvent.keyboard("{Escape}");

    expect(await screen.findByTestId("empty-collection-filtered")).toBeInTheDocument();
    expect(screen.getByText("No books match this filter")).toBeInTheDocument();
    expect(screen.queryByTestId("empty-collection")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(await screen.findByTestId("book-card")).toBeInTheDocument();
  });
});
