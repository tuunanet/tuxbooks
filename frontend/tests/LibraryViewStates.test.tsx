import { describe, expect, it } from "vite-plus/test";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { LibrarySection } from "@/state/appState";
import { makeBook, makeCollection } from "./factories";
import { alpha, beta, item, renderLibrary, renderShell } from "./libraryViewHelpers";
import { emitBridgeEvent, mockInvoke } from "./mocks/bridge";

describe("LibraryView search", () => {
  it("filters books by title", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();
    await screen.findByTestId("book-grid");

    await userEvent.type(screen.getByTestId("library-search"), "beta");

    const cards = screen.getAllByTestId("book-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent("Beta");
    expect(screen.getByTestId("library-stats")).toHaveTextContent("1 book");
  });

  it("shows a no-results state with a way back", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [alpha()],
    });

    renderLibrary();
    await screen.findByTestId("book-grid");

    await userEvent.type(screen.getByTestId("library-search"), "nothing-matches");
    expect(await screen.findByTestId("no-search-results")).toBeInTheDocument();
    expect(screen.queryByTestId("book-card")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(await screen.findByTestId("book-card")).toBeInTheDocument();
    expect(screen.queryByTestId("no-search-results")).not.toBeInTheDocument();
  });
});
describe("LibraryView sorting", () => {
  it("offers the five concrete choices with Date added as the All Books default", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();

    const trigger = await screen.findByRole("combobox", { name: "Sort books" });
    expect(trigger).toHaveTextContent("Date added");

    await userEvent.click(trigger);
    for (const label of ["Date added", "Last read", "Progress updated", "Title", "Author"]) {
      expect(await screen.findByRole("option", { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole("option", { name: "Section order" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Recently Added" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Recently Read" })).not.toBeInTheDocument();
  });

  it("reorders books when the sort control changes", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();

    // The All Books default is Date added: beta (newer) first.
    let cards = await screen.findAllByTestId("book-card");
    expect(cards[0]).toHaveTextContent("Beta");

    await userEvent.click(screen.getByRole("combobox", { name: "Sort books" }));
    await userEvent.click(await screen.findByRole("option", { name: "Title" }));

    cards = screen.getAllByTestId("book-card");
    expect(cards[0]).toHaveTextContent("Alpha");
    expect(cards[1]).toHaveTextContent("Beta");
  });

  it("marks the place default in the menu once another sort is chosen", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();
    await screen.findAllByTestId("book-card");

    await userEvent.click(screen.getByRole("combobox", { name: "Sort books" }));
    await userEvent.click(await screen.findByRole("option", { name: "Title" }));
    await userEvent.click(screen.getByRole("combobox", { name: "Sort books" }));

    expect(await screen.findByRole("option", { name: "Date added" })).toHaveTextContent(
      "(default)",
    );
    expect(screen.getByRole("option", { name: "Title" })).not.toHaveTextContent("(default)");
  });

  it("remembers the sort for each place and shows that place's default", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
      list_collections: [],
    });

    renderShell();
    await screen.findAllByTestId("book-card");

    await userEvent.click(screen.getByRole("combobox", { name: "Sort books" }));
    await userEvent.click(await screen.findByRole("option", { name: "Title" }));

    // Recently Added keeps its own default until the user sorts it.
    await userEvent.click(screen.getByRole("button", { name: "Recently Added" }));
    await screen.findByTestId("book-grid");
    expect(screen.getByRole("combobox", { name: "Sort books" })).toHaveTextContent("Date added");

    // Returning to All Books restores the remembered Title order.
    await userEvent.click(screen.getByRole("button", { name: "All Books" }));
    await screen.findByTestId("book-grid");
    expect(screen.getByRole("combobox", { name: "Sort books" })).toHaveTextContent("Title");
    const cards = screen.getAllByTestId("book-card");
    expect(item(cards, 0)).toHaveTextContent("Alpha");
    expect(item(cards, 1)).toHaveTextContent("Beta");
  });

  it("labels the date sort Added to collection and orders by membership inside a collection", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 1 },
      list_books: [alpha(), beta()],
      list_collections: [
        makeCollection({
          id: 7,
          bookIds: [1, 2],
          memberships: [
            { bookId: 1, addedAt: "2026-01-05T00:00:00.000Z" },
            { bookId: 2, addedAt: "2026-01-01T00:00:00.000Z" },
          ],
        }),
      ],
    });

    renderLibrary({ kind: "collection", ids: [7] });

    // Library order puts Beta (February) first; membership puts Alpha first.
    const cards = await screen.findAllByTestId("book-card");
    expect(item(cards, 0)).toHaveTextContent("Alpha");
    expect(item(cards, 1)).toHaveTextContent("Beta");

    const trigger = screen.getByRole("combobox", { name: "Sort books" });
    expect(trigger).toHaveTextContent("Added to collection");
    await userEvent.click(trigger);
    expect(await screen.findByRole("option", { name: "Added to collection" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Date added" })).not.toBeInTheDocument();
  });
});
describe("LibraryView reading progress synchronization", () => {
  // Regression (issue #10): saving progress in the reader must reach the
  // grid and list views live — the backend pushes the updated book over
  // `library-changed` right after persisting the save.
  it("shows the updated progress in the grid without a restart", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook({ id: 1, title: "Alpha", progressPercent: null })],
    });

    renderLibrary();
    await screen.findByTestId("book-grid");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    act(() => {
      emitBridgeEvent("library-changed", {
        kind: "changed",
        book: makeBook({ id: 1, title: "Alpha", progressPercent: 42 }),
      });
    });

    expect(
      await screen.findByRole("progressbar", { name: "Reading progress: 42%" }),
    ).toBeInTheDocument();
  });

  it("shows the updated progress in the list without a restart", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook({ id: 2, title: "Beta", progressPercent: 10 })],
    });

    renderLibrary();
    await screen.findByTestId("book-grid");
    await userEvent.click(screen.getByRole("radio", { name: "List view" }));
    expect(
      await screen.findByRole("progressbar", { name: "Reading progress: 10%" }),
    ).toBeInTheDocument();

    act(() => {
      emitBridgeEvent("library-changed", {
        kind: "changed",
        book: makeBook({ id: 2, title: "Beta", progressPercent: 63 }),
      });
    });

    expect(
      await screen.findByRole("progressbar", { name: "Reading progress: 63%" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "Reading progress: 10%" })).toBeNull();
  });
});
describe("LibraryView collection management", () => {
  it("renames the active collection and updates the library title", async () => {
    const responses: Record<string, unknown> = {
      get_library_stats: { bookCount: 1, collectionCount: 1 },
      list_books: [alpha()],
      list_collections: [makeCollection({ id: 7, name: "Favorites", bookIds: [1] })],
      rename_collection: makeCollection({ id: 7, name: "Keepers", bookIds: [1] }),
    };
    mockInvoke(responses);

    renderShell({ kind: "collection", ids: [7] });
    expect(await screen.findByRole("heading", { name: "Favorites" })).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("collection-actions-7"));
    await userEvent.click(await screen.findByTestId("collection-rename-7"));
    const input = await screen.findByTestId("collection-name");
    responses.list_collections = [makeCollection({ id: 7, name: "Keepers", bookIds: [1] })];
    await userEvent.clear(input);
    await userEvent.type(input, "Keepers{Enter}");

    expect(await screen.findByRole("heading", { name: "Keepers" })).toBeInTheDocument();
  });

  it("prunes a deleted collection from the selection and falls back to All Books", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 2 },
      list_books: [alpha(), beta()],
      list_collections: [
        makeCollection({ id: 7, name: "Favorites", bookIds: [1] }),
        makeCollection({ id: 8, name: "Research", bookIds: [2] }),
      ],
      delete_collection: true,
    });

    renderShell({ kind: "collection", ids: [7, 8] });
    expect(
      await screen.findByRole("heading", { name: "Favorites and Research" }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("collection-delete-7"));
    await userEvent.click(await screen.findByTestId("delete-collection-confirm"));
    expect(await screen.findByRole("heading", { name: "Research" })).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("collection-delete-8"));
    await userEvent.click(await screen.findByTestId("delete-collection-confirm"));
    expect(await screen.findByRole("heading", { name: "All Books" })).toBeInTheDocument();
  });
});

describe("LibraryView section explainer", () => {
  it("shows no explainer under the managed sections", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 1 },
      list_books: [makeBook({ id: 1, title: "Inside" })],
    });

    for (const section of [
      { kind: "smart", id: "all-books" },
      { kind: "smart", id: "recently-added" },
      { kind: "collection", ids: [1] },
    ] as LibrarySection[]) {
      const { container, unmount } = renderLibrary(section);
      expect(await within(container).findByTestId("library-stats")).toBeInTheDocument();
      expect(within(container).queryByTestId("library-section-explainer")).not.toBeInTheDocument();
      unmount();
    }
  });
});
