import { describe, expect, it } from "vite-plus/test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { makeBook, makeCollection } from "./factories";
import { alpha, beta, item, renderLibrary } from "./libraryViewHelpers";
import { invokeMock, mockInvoke } from "./mocks/bridge";

describe("LibraryView bulk collection actions", () => {
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
});
