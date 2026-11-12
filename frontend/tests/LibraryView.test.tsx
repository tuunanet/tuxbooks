import { describe, expect, it } from "vite-plus/test";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  COLLECTION_PREFERENCES_STORAGE_KEY,
  defaultCollectionPreferences,
} from "@/lib/collectionPreferences";
import { makeBook, makeCollection } from "./factories";
import { alpha, beta, item, renderLibrary, renderShell } from "./libraryViewHelpers";
import { mockInvoke } from "./mocks/bridge";

describe("LibraryView header", () => {
  it("shows the section title and book count", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();

    expect(await screen.findByTestId("library-header")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "All Books" })).toBeInTheDocument();
    expect(screen.getByTestId("library-stats")).toHaveTextContent("2 books");
  });

  it("names two collections in sidebar order", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 2 },
      list_books: [alpha(), beta()],
      list_collections: [
        makeCollection({ id: 7, name: "Favorites", bookIds: [1] }),
        makeCollection({ id: 8, name: "Research", bookIds: [2] }),
      ],
    });

    renderLibrary({ kind: "collection", ids: [7, 8] });

    expect(
      await screen.findByRole("heading", { name: "Favorites and Research" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("library-stats")).toHaveTextContent("2 books");
  });

  it("names two collections in the current pinned sidebar order", async () => {
    window.localStorage.setItem(
      COLLECTION_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ ...defaultCollectionPreferences(), pinned: [8], pinnedOrder: [8] }),
    );
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 2 },
      list_books: [alpha(), beta()],
      list_collections: [
        makeCollection({ id: 7, name: "Zebra", bookIds: [1] }),
        makeCollection({ id: 8, name: "alpha", bookIds: [2] }),
      ],
    });

    renderLibrary({ kind: "collection", ids: [7, 8] });

    expect(await screen.findByRole("heading", { name: "alpha and Zebra" })).toBeInTheDocument();
  });

  it("counts three or more collections", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 3 },
      list_books: [alpha()],
      list_collections: [
        makeCollection({ id: 7, name: "Favorites" }),
        makeCollection({ id: 8, name: "Research" }),
        makeCollection({ id: 9, name: "Later" }),
      ],
    });

    renderLibrary({ kind: "collection", ids: [7, 8, 9] });

    expect(await screen.findByRole("heading", { name: "3 collections" })).toBeInTheDocument();
  });

  it("ctrl+click combines two collections into one union place", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 3, collectionCount: 2 },
      list_books: [
        alpha(),
        beta(),
        makeBook({ id: 3, title: "Gamma", addedAt: "2026-03-01T00:00:00.000Z" }),
      ],
      list_collections: [
        makeCollection({ id: 7, name: "Favorites", bookIds: [1] }),
        makeCollection({ id: 8, name: "Research", bookIds: [2] }),
      ],
    });

    renderShell();
    await screen.findByTestId("book-grid");

    await userEvent.click(screen.getByRole("button", { name: "Favorites" }));
    fireEvent.click(screen.getByRole("button", { name: "Research" }), { ctrlKey: true });

    expect(
      await screen.findByRole("heading", { name: "Favorites and Research" }),
    ).toBeInTheDocument();
    const cards = screen.getAllByTestId("book-card");
    expect(cards).toHaveLength(2);
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.queryByText("Gamma")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "All Books" }));
    expect(await screen.findByRole("heading", { name: "All Books" })).toBeInTheDocument();
    expect(screen.getAllByTestId("book-card")).toHaveLength(3);
  });

  it("defaults to the grid view", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();

    expect(await screen.findByTestId("book-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("book-list")).not.toBeInTheDocument();
  });

  it("keeps the format menu open while several formats are ticked", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [
        alpha(),
        makeBook({ id: 3, path: "/tmp/library/paper.pdf", format: "pdf", title: "Paper" }),
      ],
    });

    renderLibrary();

    const trigger = await screen.findByTestId("library-format-filter");
    expect(trigger).toHaveTextContent("All formats");

    await userEvent.click(trigger);
    await userEvent.click(screen.getByTestId("format-filter-epub"));

    expect(screen.getByTestId("library-format-filter")).toHaveTextContent("EPUB");
    // The menu is still open because a checkbox item does not dismiss it.
    expect(screen.getByTestId("format-filter-pdf")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("format-filter-pdf"));
    expect(screen.getByTestId("library-format-filter")).toHaveTextContent("2 formats");

    await userEvent.click(screen.getByTestId("format-filter-all"));
    expect(screen.getByTestId("library-format-filter")).toHaveTextContent("All formats");
  });

  it("composes the format filter with the section", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [
        makeBook({
          id: 1,
          title: "Reading EPUB",
          progressPercent: 40,
          progressUpdatedAt: "2026-03-01T00:00:00.000Z",
        }),
        makeBook({
          id: 2,
          path: "/tmp/library/reading.pdf",
          format: "pdf",
          title: "Reading PDF",
          progressPercent: 40,
          progressUpdatedAt: "2026-03-02T00:00:00.000Z",
        }),
      ],
    });

    renderLibrary({ kind: "smart", id: "in-progress" });
    expect(await screen.findAllByTestId("book-card")).toHaveLength(2);

    await userEvent.click(await screen.findByTestId("library-format-filter"));
    await userEvent.click(screen.getByTestId("format-filter-pdf"));

    expect(await screen.findAllByTestId("book-card")).toHaveLength(1);
    expect(screen.getByText("Reading PDF")).toBeInTheDocument();
  });
});

describe("LibraryView selection and opening", () => {
  it("selects on single click and opens the detail on double click", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [alpha()],
    });

    renderShell();
    const card = await screen.findByTestId("book-card");

    fireEvent.click(card);
    expect(card).toHaveAttribute("aria-pressed", "true");

    fireEvent.doubleClick(card);
    expect(await screen.findByTestId("book-detail")).toBeInTheDocument();
  });

  it("opens the detail view with Enter on a focused card", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderShell();
    const firstCard = item(await screen.findAllByTestId("book-card"), 0);
    fireEvent.click(firstCard);

    fireEvent.keyDown(firstCard, { key: "Enter" });
    expect(await screen.findByTestId("book-detail")).toBeInTheDocument();
  });

  it("restores the grid scroll position after a detail round trip", async () => {
    // Regression (issue #61 phase 1 QA): returning from the detail view
    // lost the scroll position — the save read a ref React had already
    // nulled during unmount. Saving happens on scroll now.
    mockInvoke({
      get_library_stats: { bookCount: 40, collectionCount: 0 },
      list_books: Array.from({ length: 40 }, (_, index) =>
        makeBook({ id: index + 1, title: `Shelf Book ${index + 1}` }),
      ),
    });

    renderShell();
    const grid = await screen.findByTestId("book-grid");
    grid.scrollTop = 5000;
    grid.dispatchEvent(new Event("scroll"));

    const card = screen.getAllByTestId("book-card").at(0);
    if (!card) throw new Error("expected a card");
    fireEvent.doubleClick(card);
    expect(await screen.findByTestId("book-detail")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("detail-back"));
    const restored = await screen.findByTestId("book-grid");
    expect(restored.scrollTop).toBe(5000);
  });

  it("roves focus through the cards with arrow keys", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 3, collectionCount: 0 },
      list_books: [alpha(), beta(), makeBook({ id: 3, title: "Gamma" })],
    });

    renderLibrary();
    const grid = await screen.findByTestId("book-grid");
    const cards = await screen.findAllByTestId("book-card");

    // jsdom has no computed grid template, so the grid behaves as one column.
    fireEvent.click(item(cards, 0));
    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(document.activeElement).toBe(item(cards, 1));

    fireEvent.keyDown(grid, { key: "ArrowDown" });
    expect(document.activeElement).toBe(item(cards, 2));

    fireEvent.keyDown(grid, { key: "Home" });
    expect(document.activeElement).toBe(item(cards, 0));

    fireEvent.keyDown(grid, { key: "End" });
    expect(document.activeElement).toBe(item(cards, 2));
  });
});

describe("LibraryView view modes", () => {
  it("switches between grid and list rendering", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();
    await screen.findByTestId("book-grid");

    // Radix single-select toggle groups render radio semantics.
    await userEvent.click(screen.getByRole("radio", { name: "List view" }));

    expect(await screen.findByTestId("book-list")).toBeInTheDocument();
    expect(screen.getAllByTestId("book-list-item")).toHaveLength(2);
    expect(screen.queryByTestId("book-card")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "Grid view" }));
    expect(await screen.findByTestId("book-grid")).toBeInTheDocument();
  });
});
