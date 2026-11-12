import { describe, expect, it } from "vite-plus/test";
import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { makeBook } from "./factories";
import { alpha, beta, item, renderLibrary, renderShell } from "./libraryViewHelpers";
import { mockInvoke } from "./mocks/bridge";

describe("LibraryView multi-selection", () => {
  /** The default Date added order shows them as Alpha, Gamma, Beta: ids out of order. */
  const outOfOrderBooks = () => [
    makeBook({ id: 1, title: "Alpha", addedAt: "2026-03-01T00:00:00.000Z" }),
    makeBook({ id: 2, title: "Beta", addedAt: "2026-01-01T00:00:00.000Z" }),
    makeBook({ id: 3, title: "Gamma", addedAt: "2026-02-01T00:00:00.000Z" }),
  ];

  it("marks the clicked card with the blue selection and shows no bar below two books", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [alpha()],
    });

    renderLibrary();
    const card = await screen.findByTestId("book-card");

    expect(card).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("selection-bar")).not.toBeInTheDocument();

    fireEvent.click(card);

    expect(card).toHaveAttribute("aria-pressed", "true");
    expect(card).toHaveClass("bg-library-selection/20", "ring-library-selection");
    expect(screen.queryByTestId("selection-bar")).not.toBeInTheDocument();
  });

  it("toggles books with ctrl+click and counts them on the selection bar", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();
    const cards = await screen.findAllByTestId("book-card");

    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { ctrlKey: true });

    expect(cards.map((card) => card.getAttribute("aria-pressed"))).toEqual(["true", "true"]);
    expect(screen.getByTestId("selection-count")).toHaveTextContent("2 books selected");

    fireEvent.click(item(cards, 1), { ctrlKey: true });

    expect(item(cards, 1)).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("selection-bar")).not.toBeInTheDocument();
  });

  it("clears the selection from the bar's Clear control", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { ctrlKey: true });

    await userEvent.click(screen.getByTestId("selection-clear"));

    expect(screen.queryByTestId("selection-bar")).not.toBeInTheDocument();
    expect(cards.map((card) => card.getAttribute("aria-pressed"))).toEqual(["false", "false"]);
  });

  it("takes the shift+click range over the visible order", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 3, collectionCount: 0 },
      list_books: outOfOrderBooks(),
    });

    renderLibrary();
    const cards = await screen.findAllByTestId("book-card");
    // Date added puts the ids on screen as 1, 3, 2. The range has to follow
    // that, not the ids' own order.
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "Alpha (EPUB)",
      "Gamma (EPUB)",
      "Beta (EPUB)",
    ]);

    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { shiftKey: true });

    expect(item(cards, 0)).toHaveAttribute("aria-pressed", "true");
    expect(item(cards, 1)).toHaveAttribute("aria-pressed", "true");
    expect(item(cards, 2)).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("selection-count")).toHaveTextContent("2 books selected");

    // The anchor is still the plain click, so the next range runs from
    // Alpha again and reaches Beta at the end of the visible order.
    fireEvent.click(item(cards, 2), { shiftKey: true });

    expect(screen.getByTestId("selection-count")).toHaveTextContent("3 books selected");
  });

  it("keeps the selection and the bar when a search hides a selected book", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { ctrlKey: true });

    await userEvent.type(screen.getByTestId("library-search"), "alpha");

    expect(screen.getAllByTestId("book-card")).toHaveLength(1);
    expect(screen.getByTestId("book-card")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("selection-count")).toHaveTextContent("2 books selected");

    await userEvent.clear(screen.getByTestId("library-search"));

    expect(screen.getAllByTestId("book-card")).toHaveLength(2);
    expect(cards.map((card) => card.getAttribute("aria-pressed"))).toEqual(["true", "true"]);
  });

  it("clears a filtered-away selection from the empty state", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { ctrlKey: true });

    await userEvent.type(screen.getByTestId("library-search"), "nothing-matches");
    expect(await screen.findByTestId("no-search-results")).toBeInTheDocument();
    expect(screen.getByTestId("selection-count")).toHaveTextContent("2 books selected");

    fireEvent.click(screen.getByTestId("no-search-results"));

    expect(screen.queryByTestId("selection-bar")).not.toBeInTheDocument();
  });

  it("keeps the selection when the sort changes", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();
    // The default Date added order puts Beta first; it is the book that gets selected.
    const cards = await screen.findAllByTestId("book-card");
    expect(item(cards, 0)).toHaveTextContent("Beta");
    fireEvent.click(item(cards, 0));

    await userEvent.click(screen.getByRole("combobox", { name: "Sort books" }));
    await userEvent.click(await screen.findByRole("option", { name: "Title" }));

    const sorted = screen.getAllByTestId("book-card");
    expect(item(sorted, 0)).toHaveTextContent("Alpha");
    expect(item(sorted, 0)).toHaveAttribute("aria-pressed", "false");
    expect(item(sorted, 1)).toHaveTextContent("Beta");
    expect(item(sorted, 1)).toHaveAttribute("aria-pressed", "true");
  });

  it("clears the selection on empty space, on click and on right click", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();
    const grid = await screen.findByTestId("book-grid");
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { ctrlKey: true });
    expect(screen.getByTestId("selection-bar")).toBeInTheDocument();

    fireEvent.click(grid);
    expect(screen.queryByTestId("selection-bar")).not.toBeInTheDocument();
    expect(cards.map((card) => card.getAttribute("aria-pressed"))).toEqual(["false", "false"]);

    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { ctrlKey: true });
    fireEvent.contextMenu(grid);

    expect(screen.queryByTestId("selection-bar")).not.toBeInTheDocument();
    expect(cards.map((card) => card.getAttribute("aria-pressed"))).toEqual(["false", "false"]);
  });

  it("keeps the selection when a modifier click lands on empty space", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();
    const grid = await screen.findByTestId("book-grid");
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { ctrlKey: true });

    fireEvent.click(grid, { ctrlKey: true });
    fireEvent.click(grid, { shiftKey: true });

    expect(screen.getByTestId("selection-count")).toHaveTextContent("2 books selected");
  });

  it("right click takes over an unselected book and keeps a live selection", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();
    const cards = await screen.findAllByTestId("book-card");

    fireEvent.contextMenu(item(cards, 1));
    expect(item(cards, 1)).toHaveAttribute("aria-pressed", "true");
    expect(item(cards, 0)).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("selection-bar")).not.toBeInTheDocument();

    fireEvent.click(item(cards, 0), { ctrlKey: true });
    fireEvent.contextMenu(item(cards, 1));

    expect(cards.map((card) => card.getAttribute("aria-pressed"))).toEqual(["true", "true"]);
    expect(screen.getByTestId("selection-count")).toHaveTextContent("2 books selected");
  });

  it("keeps the anchor on the last plain click when a right click takes over", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 3, collectionCount: 0 },
      list_books: outOfOrderBooks(),
    });

    renderLibrary();
    const cards = await screen.findAllByTestId("book-card");
    // Visible order is Alpha, Gamma, Beta.
    fireEvent.click(item(cards, 0));
    fireEvent.contextMenu(item(cards, 2));

    expect(cards.map((card) => card.getAttribute("aria-pressed"))).toEqual([
      "false",
      "false",
      "true",
    ]);

    // The range still starts at the plain click, so it runs Alpha..Gamma
    // and leaves the right-clicked Beta out.
    fireEvent.click(item(cards, 1), { shiftKey: true });

    expect(cards.map((card) => card.getAttribute("aria-pressed"))).toEqual([
      "true",
      "true",
      "false",
    ]);
  });

  it("clears the selection when the sidebar section changes", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
      list_collections: [],
    });

    renderShell();
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { ctrlKey: true });
    expect(screen.getByTestId("selection-bar")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Recently Added" }));

    expect(await screen.findByTestId("book-grid")).toBeInTheDocument();
    const afterSwitch = screen.getAllByTestId("book-card");
    expect(afterSwitch.map((card) => card.getAttribute("aria-pressed"))).toEqual([
      "false",
      "false",
    ]);
    expect(screen.queryByTestId("selection-bar")).not.toBeInTheDocument();
  });

  it("marks the selected row with the blue selection in list view", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();
    await screen.findByTestId("book-grid");
    await userEvent.click(screen.getByRole("radio", { name: "List view" }));

    const rows = await screen.findAllByTestId("book-list-item");
    fireEvent.click(item(rows, 0));

    expect(item(rows, 0)).toHaveAttribute("aria-pressed", "true");
    expect(item(rows, 0)).toHaveClass("bg-library-selection/20", "ring-library-selection");
    expect(item(rows, 1)).toHaveAttribute("aria-pressed", "false");
  });
});
