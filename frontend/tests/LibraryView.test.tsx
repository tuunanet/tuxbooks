import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { LibraryView } from "@/components/library/LibraryView";
import { AppShell } from "@/components/layout/AppShell";
import { AppStateProvider } from "@/state/AppStateProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import type { LibrarySection } from "@/state/appState";
import { makeBook, makeCollection } from "./factories";
import { emitBridgeEvent, invokeMock, mockInvoke } from "./mocks/bridge";

function renderLibrary(section: LibrarySection = { kind: "smart", id: "all-books" }) {
  return render(
    <AppStateProvider>
      <LibraryDataProvider>
        <ImportProvider>
          <LibraryView section={section} />
        </ImportProvider>
      </LibraryDataProvider>
    </AppStateProvider>,
  );
}

/** Full shell: needed when the test asserts view changes (detail/reader). */
function renderShell(section: LibrarySection = { kind: "smart", id: "all-books" }) {
  return render(
    <AppShell
      initialState={{
        view: "library",
        section,
        selectedBookId: null,
        libraryQuery: "",
      }}
    />,
  );
}

const alpha = () =>
  makeBook({ id: 1, title: "Alpha", author: "Zed Author", addedAt: "2026-01-01T00:00:00.000Z" });
const beta = () =>
  makeBook({
    id: 2,
    title: "Beta",
    author: "Yuki Author",
    addedAt: "2026-02-01T00:00:00.000Z",
  });

/** Indexes with a runtime guard so `noUncheckedIndexedAccess` stays honest. */
function item<T>(items: T[], index: number): T {
  const value = items.at(index);
  if (value === undefined) throw new Error(`expected an item at index ${index}`);
  return value;
}

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

  it("defaults to the grid view", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();

    expect(await screen.findByTestId("book-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("book-list")).not.toBeInTheDocument();
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

describe("LibraryView multi-selection", () => {
  /** Recently Added shows them as Alpha, Gamma, Beta: ids out of order. */
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
    // Recently Added puts the ids on screen as 1, 3, 2. The range has to
    // follow that, not the ids' own order.
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
    // Recently Added puts Beta first; it is the book that gets selected.
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

describe("LibraryView bulk context menu", () => {
  /** A book whose file is gone, so the single menu carries Locate File…. */
  const lost = () => makeBook({ id: 3, title: "Lost", available: false });

  /**
   * Collections around the Alpha (1) / Beta (2) selection: Fantasy holds
   * neither, Sci-Fi holds Alpha only, Favorites holds both.
   */
  const bulkCollections = () => [
    makeCollection({ id: 10, name: "Fantasy", bookIds: [] }),
    makeCollection({ id: 11, name: "Sci-Fi", bookIds: [1] }),
    makeCollection({ id: 12, name: "Favorites", bookIds: [1, 2] }),
  ];

  /** Selects both books and right-clicks the bulk menu open on the second. */
  async function openBulkMenu() {
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { ctrlKey: true });
    fireEvent.contextMenu(item(cards, 1));
    return screen.findByRole("menu");
  }

  it("keeps the full single-book menu at a selection of one", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), lost()],
      list_collections: [],
    });

    renderLibrary();
    const cards = await screen.findAllByTestId("book-card");

    // Click then right click on the same book: the selection stays at one.
    fireEvent.click(item(cards, 1));
    fireEvent.contextMenu(item(cards, 1));

    await screen.findByRole("menuitem", { name: "Open" });
    expect(screen.getByRole("menuitem", { name: "Mark as Finished" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Add to Collection" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remove from Collection" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Edit Metadata" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Locate File…" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Remove from Library" })).toBeInTheDocument();
    // The missing file keeps its old disabled states on this menu too.
    expect(screen.getByRole("menuitem", { name: "Continue Reading" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitem", { name: "Show in File Manager" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(
      screen.queryByRole("menuitem", { name: "Remove 3 Books from Library" }),
    ).not.toBeInTheDocument();
  });

  it("offers only the four bulk items at a selection of several", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 3, collectionCount: 3 },
      list_books: [alpha(), beta(), lost()],
      list_collections: bulkCollections(),
    });

    renderLibrary();
    const cards = await screen.findAllByTestId("book-card");

    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { ctrlKey: true });
    fireEvent.click(item(cards, 2), { ctrlKey: true });
    fireEvent.contextMenu(item(cards, 2));

    const menu = await screen.findByRole("menu");
    const names = within(menu)
      .getAllByRole("menuitem")
      .map((node) => node.textContent);
    expect(names).toHaveLength(4);
    expect(names).toEqual(
      expect.arrayContaining([
        "Add to Collection",
        "Remove from Collection",
        "Mark as Finished",
        "Remove 3 Books from Library",
      ]),
    );
    expect(
      within(menu).getByRole("menuitem", { name: "Remove 3 Books from Library" }),
    ).toHaveAttribute("data-variant", "destructive");

    // All three bulk entries are live: both collection submenus and the
    // mark-as-finished entry.
    for (const live of ["Add to Collection", "Remove from Collection", "Mark as Finished"]) {
      expect(within(menu).getByRole("menuitem", { name: live })).not.toHaveAttribute(
        "aria-disabled",
        "true",
      );
    }

    for (const hidden of [
      "Open",
      "Continue Reading",
      "Edit Metadata",
      "Locate File…",
      "Show in File Manager",
      "Remove from Library",
    ]) {
      expect(within(menu).queryByRole("menuitem", { name: hidden })).not.toBeInTheDocument();
    }
  });

  it("lists only the collections a selected book is missing and adds just those books", async () => {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 3 },
      list_books: [alpha(), beta()],
      list_collections: bulkCollections(),
      add_book_to_collection: null,
    });

    renderLibrary();
    const menu = await openBulkMenu();

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Add to Collection" }));

    // Fantasy holds neither book and Sci-Fi holds Alpha; Favorites holds
    // every selected book, so it stays out of the list.
    expect(await screen.findByTestId("context-add-to-collection-10")).toBeInTheDocument();
    expect(screen.getByTestId("context-add-to-collection-11")).toBeInTheDocument();
    expect(screen.queryByTestId("context-add-to-collection-12")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("context-add-to-collection-11"));

    // Sci-Fi already has Alpha: only Beta gets the bridge call.
    expect(invokeMock).toHaveBeenCalledWith("add_book_to_collection", {
      bookId: 2,
      collectionId: 11,
    });
    expect(invokeMock).not.toHaveBeenCalledWith("add_book_to_collection", {
      bookId: 1,
      collectionId: 11,
    });
  });

  it("lists only the collections holding a selected member and removes just those", async () => {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 3 },
      list_books: [alpha(), beta()],
      list_collections: bulkCollections(),
      remove_book_from_collection: true,
    });

    renderLibrary();
    const menu = await openBulkMenu();

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Remove from Collection" }));

    // Sci-Fi holds Alpha and Favorites holds both; Fantasy holds none.
    expect(await screen.findByTestId("context-remove-from-collection-11")).toBeInTheDocument();
    expect(screen.getByTestId("context-remove-from-collection-12")).toBeInTheDocument();
    expect(screen.queryByTestId("context-remove-from-collection-10")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("context-remove-from-collection-11"));

    // Sci-Fi holds Alpha only: one membership dropped, Beta untouched.
    expect(invokeMock).toHaveBeenCalledWith("remove_book_from_collection", {
      bookId: 1,
      collectionId: 11,
    });
    expect(invokeMock).not.toHaveBeenCalledWith("remove_book_from_collection", {
      bookId: 2,
      collectionId: 11,
    });
  });

  it("handles a mixed selection without duplicate bridge calls", async () => {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 3 },
      list_books: [alpha(), beta()],
      list_collections: bulkCollections(),
      add_book_to_collection: null,
      remove_book_from_collection: true,
    });

    renderLibrary();
    const menu = await openBulkMenu();

    // Sci-Fi holds Alpha: the member gets no second add, the gap gets one.
    await userEvent.click(within(menu).getByRole("menuitem", { name: "Add to Collection" }));
    await userEvent.click(await screen.findByTestId("context-add-to-collection-11"));
    const addCalls = invokeMock.mock.calls.filter(
      ([method]) => method === "add_book_to_collection",
    );
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]).toEqual(["add_book_to_collection", { bookId: 2, collectionId: 11 }]);

    // Favorites holds both selected books: one removal per member, no repeats.
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.contextMenu(item(cards, 1));
    const reopened = await screen.findByRole("menu");
    await userEvent.click(
      within(reopened).getByRole("menuitem", { name: "Remove from Collection" }),
    );
    await userEvent.click(await screen.findByTestId("context-remove-from-collection-12"));
    const removeCalls = invokeMock.mock.calls.filter(
      ([method]) => method === "remove_book_from_collection",
    );
    expect(removeCalls).toHaveLength(2);
    expect(invokeMock).toHaveBeenCalledWith("remove_book_from_collection", {
      bookId: 1,
      collectionId: 12,
    });
    expect(invokeMock).toHaveBeenCalledWith("remove_book_from_collection", {
      bookId: 2,
      collectionId: 12,
    });

    // Both chains resolved far enough to post their note; nothing rejected.
    await waitFor(() =>
      expect(screen.getByTestId("selection-message")).toHaveTextContent("Removed 2 from Favorites"),
    );
  });

  it("keeps the selection and reports the result on the bar", async () => {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 3 },
      list_books: [alpha(), beta()],
      list_collections: bulkCollections(),
      add_book_to_collection: null,
      remove_book_from_collection: true,
    });

    renderLibrary();
    const menu = await openBulkMenu();

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Add to Collection" }));
    await userEvent.click(await screen.findByTestId("context-add-to-collection-10"));
    await waitFor(() =>
      expect(screen.getByTestId("selection-message")).toHaveTextContent("Added 2 to Fantasy"),
    );
    expect(screen.getByTestId("selection-count")).toHaveTextContent("2 books selected");

    // The selection survived, so the next action chains off it.
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.contextMenu(item(cards, 1));
    const reopened = await screen.findByRole("menu");
    await userEvent.click(
      within(reopened).getByRole("menuitem", { name: "Remove from Collection" }),
    );
    await userEvent.click(await screen.findByTestId("context-remove-from-collection-11"));
    await waitFor(() =>
      expect(screen.getByTestId("selection-message")).toHaveTextContent("Removed 1 from Sci-Fi"),
    );
    expect(screen.getByTestId("selection-count")).toHaveTextContent("2 books selected");
    expect(
      (await screen.findAllByTestId("book-card")).map((card) => card.getAttribute("aria-pressed")),
    ).toEqual(["true", "true"]);
  });

  it("refreshes collections once after the bulk loop", async () => {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 3 },
      list_books: [alpha(), beta()],
      list_collections: bulkCollections(),
      add_book_to_collection: null,
    });

    renderLibrary();
    const menu = await openBulkMenu();

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Add to Collection" }));
    await userEvent.click(await screen.findByTestId("context-add-to-collection-10"));

    expect(
      invokeMock.mock.calls.filter(([method]) => method === "add_book_to_collection"),
    ).toHaveLength(2);
    // The mount fetch plus exactly one refresh after the loop; the note
    // only posts once that refresh has resolved.
    await waitFor(() =>
      expect(screen.getByTestId("selection-message")).toHaveTextContent("Added 2 to Fantasy"),
    );
    expect(invokeMock.mock.calls.filter(([method]) => method === "list_collections")).toHaveLength(
      2,
    );
  });

  it("offers the empty placeholders when the library has no collections yet", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
      list_collections: [],
    });

    renderLibrary();
    const menu = await openBulkMenu();

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Add to Collection" }));
    const empty = await screen.findByTestId("context-no-collections");
    expect(empty).toHaveAttribute("aria-disabled", "true");
    expect(empty).toHaveTextContent("No collections yet");
    // Nothing to leave, so the remove submenu stays shut.
    expect(within(menu).getByRole("menuitem", { name: "Remove from Collection" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("refreshes and reports honestly when a membership call fails", async () => {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 3 },
      list_books: [alpha(), beta()],
      list_collections: bulkCollections(),
      add_book_to_collection: new Error("membership rejected"),
    });

    renderLibrary();
    const menu = await openBulkMenu();

    await userEvent.click(within(menu).getByRole("menuitem", { name: "Add to Collection" }));
    await userEvent.click(await screen.findByTestId("context-add-to-collection-10"));

    // Nothing landed, so the note counts zero, and the refresh still runs
    // so the menus do not go stale behind a failed batch.
    await waitFor(() =>
      expect(screen.getByTestId("selection-message")).toHaveTextContent("Added 0 to Fantasy"),
    );
    expect(invokeMock.mock.calls.filter(([method]) => method === "list_collections")).toHaveLength(
      2,
    );
    expect(screen.getByTestId("selection-count")).toHaveTextContent("2 books selected");
  });

  it("asks once before a bulk remove, naming the count and the files on disk", async () => {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
      list_collections: [],
    });

    renderLibrary();
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { ctrlKey: true });
    fireEvent.contextMenu(item(cards, 1));

    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove 2 Books from Library" }),
    );

    const dialogs = await screen.findAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    expect(item(dialogs, 0)).toHaveTextContent("Remove 2 books from the library?");
    expect(item(dialogs, 0)).toHaveTextContent(/files on disk/i);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("remove_book", expect.anything());
    expect(screen.getByTestId("selection-count")).toHaveTextContent("2 books selected");
  });

  it("removes every selected book, refreshes once, clears the selection and reports on the bar", async () => {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 3, collectionCount: 0 },
      list_books: [
        alpha(),
        beta(),
        makeBook({ id: 3, title: "Gamma", addedAt: "2026-03-01T00:00:00.000Z" }),
      ],
      list_collections: [],
    });

    renderLibrary();
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { ctrlKey: true });
    fireEvent.click(item(cards, 2), { ctrlKey: true });
    fireEvent.contextMenu(item(cards, 2));

    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Remove 3 Books from Library" }),
    );
    await userEvent.click(await screen.findByTestId("bulk-remove-confirm"));

    expect(invokeMock).toHaveBeenCalledWith("remove_book", { bookId: 1 });
    expect(invokeMock).toHaveBeenCalledWith("remove_book", { bookId: 2 });
    expect(invokeMock).toHaveBeenCalledWith("remove_book", { bookId: 3 });

    // The mount fetch plus exactly one refresh after the loop.
    expect(invokeMock.mock.calls.filter(([method]) => method === "list_books")).toHaveLength(2);

    await waitFor(() =>
      expect(screen.getByTestId("selection-message")).toHaveTextContent(
        "Removed 3 books from the library",
      ),
    );
    expect(screen.queryByTestId("selection-count")).not.toBeInTheDocument();

    const after = await screen.findAllByTestId("book-card");
    expect(after.map((card) => card.getAttribute("aria-pressed"))).toEqual([
      "false",
      "false",
      "false",
    ]);
  });

  it("retires the result note on its own", async () => {
    // The note expires on a timer; fake clocks drive that one assertion
    // while every interaction stays synchronous (fireEvent, no waits).
    vi.useFakeTimers();
    try {
      mockInvoke({
        get_library_stats: { bookCount: 2, collectionCount: 0 },
        list_books: [alpha(), beta()],
        list_collections: [],
      });

      renderLibrary();
      await act(async () => {});

      const cards = screen.getAllByTestId("book-card");
      fireEvent.click(item(cards, 0));
      fireEvent.click(item(cards, 1), { ctrlKey: true });
      fireEvent.contextMenu(item(cards, 1));
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove 2 Books from Library" }));
      fireEvent.click(screen.getByTestId("bulk-remove-confirm"));

      // The per-book calls and the refresh resolve as microtasks.
      await act(async () => {});
      expect(screen.getByTestId("selection-message")).toHaveTextContent(
        "Removed 2 books from the library",
      );

      act(() => {
        vi.advanceTimersByTime(4000);
      });

      expect(screen.queryByTestId("selection-bar")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes a single book from the menu with no dialog", async () => {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [alpha()],
      list_collections: [],
    });

    renderLibrary();
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.contextMenu(item(cards, 0));

    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove from Library" }));

    expect(invokeMock).toHaveBeenCalledWith("remove_book", { bookId: 1 });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("selection-bar")).not.toBeInTheDocument();
  });

  /** Mixed progress: Alpha and Beta are unfinished, Gamma already at 100%. */
  function mockMixedProgressLibrary() {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 3, collectionCount: 0 },
      list_books: [
        alpha(),
        beta(),
        makeBook({
          id: 3,
          title: "Gamma",
          addedAt: "2026-03-01T00:00:00.000Z",
          progressPercent: 100,
        }),
      ],
      list_collections: [],
      mark_book_finished: null,
    });
  }

  /** Selects every card, then picks Mark as Finished off the bulk menu. */
  async function bulkMarkFinished() {
    const cards = await screen.findAllByTestId("book-card");
    fireEvent.click(item(cards, 0));
    fireEvent.click(item(cards, 1), { ctrlKey: true });
    fireEvent.click(item(cards, 2), { ctrlKey: true });
    fireEvent.contextMenu(item(cards, 2));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Mark as Finished" }));
  }

  it("marks only the unfinished selected books, skipping the finished one", async () => {
    mockMixedProgressLibrary();

    renderLibrary();
    await bulkMarkFinished();

    await waitFor(() =>
      expect(screen.getByTestId("selection-message")).toHaveTextContent(
        "Marked 2 books as finished",
      ),
    );
    const marks = invokeMock.mock.calls.filter(([method]) => method === "mark_book_finished");
    expect(marks).toHaveLength(2);
    expect(marks.map(([, params]) => params)).toEqual(
      expect.arrayContaining([{ bookId: 1 }, { bookId: 2 }]),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("mark_book_finished", { bookId: 3 });
  });

  it("keeps the selection after the batch", async () => {
    mockMixedProgressLibrary();

    renderLibrary();
    await bulkMarkFinished();

    await waitFor(() =>
      expect(screen.getByTestId("selection-message")).toHaveTextContent(
        "Marked 2 books as finished",
      ),
    );
    expect(screen.getByTestId("selection-count")).toHaveTextContent("3 books selected");
    expect(
      (await screen.findAllByTestId("book-card")).map((card) => card.getAttribute("aria-pressed")),
    ).toEqual(["true", "true", "true"]);
  });

  it("refreshes the library exactly once after the batch", async () => {
    mockMixedProgressLibrary();

    renderLibrary();
    await bulkMarkFinished();

    await waitFor(() =>
      expect(screen.getByTestId("selection-message")).toHaveTextContent(
        "Marked 2 books as finished",
      ),
    );
    // The mount fetch plus exactly one refresh after the loop.
    expect(invokeMock.mock.calls.filter(([method]) => method === "list_books")).toHaveLength(2);
  });

  it("skips the bridge entirely when every selected book is finished", async () => {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 3, collectionCount: 0 },
      list_books: [
        makeBook({
          id: 1,
          title: "Alpha",
          addedAt: "2026-01-01T00:00:00.000Z",
          progressPercent: 100,
        }),
        makeBook({
          id: 2,
          title: "Beta",
          addedAt: "2026-02-01T00:00:00.000Z",
          progressPercent: 100,
        }),
        makeBook({
          id: 3,
          title: "Gamma",
          addedAt: "2026-03-01T00:00:00.000Z",
          progressPercent: 100,
        }),
      ],
      list_collections: [],
      mark_book_finished: null,
    });

    renderLibrary();
    await bulkMarkFinished();

    await waitFor(() =>
      expect(screen.getByTestId("selection-message")).toHaveTextContent(
        "All selected books are already finished",
      ),
    );
    expect(
      invokeMock.mock.calls.filter(([method]) => method === "mark_book_finished"),
    ).toHaveLength(0);
    expect(invokeMock.mock.calls.filter(([method]) => method === "list_books")).toHaveLength(1);
    expect(screen.getByTestId("selection-count")).toHaveTextContent("3 books selected");
  });
});

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
  it("reorders books when the sort control changes", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [alpha(), beta()],
    });

    renderLibrary();

    // Default sort is Recently Added: beta (newer) first.
    let cards = await screen.findAllByTestId("book-card");
    expect(cards[0]).toHaveTextContent("Beta");

    await userEvent.click(screen.getByRole("combobox", { name: "Sort books" }));
    await userEvent.click(await screen.findByRole("option", { name: "Title" }));

    cards = screen.getAllByTestId("book-card");
    expect(cards[0]).toHaveTextContent("Alpha");
    expect(cards[1]).toHaveTextContent("Beta");
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

describe("LibraryView empty states", () => {
  it("shows the empty-section state for a filtered section without books", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [alpha()],
    });

    renderLibrary({ kind: "smart", id: "pdfs" });

    expect(await screen.findByTestId("empty-section")).toBeInTheDocument();
    expect(screen.getByTestId("library-stats")).toHaveTextContent("0 books");
  });

  it("shows the empty-collection state for a collection section", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 1 },
      list_books: [],
    });

    renderLibrary({ kind: "collection", id: 1 });

    expect(await screen.findByTestId("empty-collection")).toBeInTheDocument();
  });
});

describe("LibraryView outside watched folders", () => {
  it("shows only loose books in the loose-books section", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [
        makeBook({ id: 1, title: "Inside", loose: false }),
        makeBook({ id: 2, title: "Dropped In", loose: true }),
      ],
    });

    renderLibrary({ kind: "smart", id: "outside-watched" });

    const cards = await screen.findAllByTestId("book-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent("Dropped In");
    expect(screen.getByRole("heading", { name: "Outside Watched Folders" })).toBeInTheDocument();
  });

  it("falls back to All Books when no loose book remains", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook({ id: 1, title: "Inside", loose: false })],
    });

    renderLibrary({ kind: "smart", id: "outside-watched" });

    expect(await screen.findByRole("heading", { name: "All Books" })).toBeInTheDocument();
    expect(screen.getByTestId("book-card")).toHaveTextContent("Inside");
  });
});
