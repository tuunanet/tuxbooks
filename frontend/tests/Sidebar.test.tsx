import { describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Sidebar } from "@/components/layout/Sidebar";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { initialAppState } from "@/state/appState";
import { makeBook, makeCollection } from "./factories";
import { invokeMock, mockInvoke } from "./mocks/bridge";
import {
  COLLECTION_PREFERENCES_STORAGE_KEY,
  type CollectionPreferences,
  collectionNames,
  collectionRow,
  renderSidebar,
  seedCollectionPreferences,
} from "./sidebarHelpers";

describe("Sidebar", () => {
  it("renders the navigation groups and items", () => {
    renderSidebar(vi.fn());

    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByText("Library")).toBeInTheDocument();
    expect(screen.getByTestId("new-collection-button")).toBeInTheDocument();
    for (const label of [
      "All Books",
      "Recently Added",
      "Recently Read",
      "In Progress",
      "Finished",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    // Format filters live in the library header now, not the sidebar.
    expect(screen.queryByRole("button", { name: "EPUBs" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "PDFs" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Loose Books" })).not.toBeInTheDocument();
  });

  it("renders no loose entry even when the library has books", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [makeBook({ id: 1, title: "Alpha" }), makeBook({ id: 2, title: "Beta" })],
      list_collections: [],
    });
    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <Sidebar
            active={initialAppState.section}
            onSectionChange={vi.fn()}
            onCollectionSelect={vi.fn()}
            onCollectionDeleted={vi.fn()}
            onOpenSettings={vi.fn()}
          />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    expect(await screen.findByRole("button", { name: "All Books" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Loose Books" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Outside Watched Folders" }),
    ).not.toBeInTheDocument();
  });

  it("marks the active section and updates on click", async () => {
    const onSectionChange = vi.fn();
    renderSidebar(onSectionChange);

    const allBooks = screen.getByRole("button", { name: "All Books" });
    expect(allBooks).toHaveAttribute("aria-current");

    await userEvent.click(screen.getByRole("button", { name: "Recently Added" }));
    expect(onSectionChange).toHaveBeenCalledWith({ kind: "smart", id: "recently-added" });
  });

  it("opens settings without changing the active section", async () => {
    const onSectionChange = vi.fn();
    const onOpenSettings = vi.fn();
    renderSidebar(onSectionChange, onOpenSettings);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    expect(onSectionChange).not.toHaveBeenCalled();
  });

  it("opens the create-collection dialog", async () => {
    renderSidebar(vi.fn());

    await userEvent.click(screen.getByTestId("new-collection-button"));

    const dialog = await screen.findByTestId("collection-dialog");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByTestId("collection-name")).toBeInTheDocument();
    // Create stays disabled until a name is typed.
    expect(screen.getByTestId("collection-create")).toBeDisabled();
  });

  it("lists collections as clickable places", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 1 },
      list_books: [],
      list_collections: [makeCollection({ id: 5, name: "Vacation Reads" })],
    });
    const onCollectionSelect = vi.fn();
    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <Sidebar
            active={initialAppState.section}
            onSectionChange={vi.fn()}
            onCollectionSelect={onCollectionSelect}
            onCollectionDeleted={vi.fn()}
            onOpenSettings={vi.fn()}
          />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    expect(await screen.findByText("Vacation Reads")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Vacation Reads"));
    expect(onCollectionSelect).toHaveBeenCalledWith(5, "replace", [5]);
  });

  it("marks every selected collection row active", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 2 },
      list_books: [],
      list_collections: [
        makeCollection({ id: 5, name: "Favorites" }),
        makeCollection({ id: 7, name: "Research" }),
      ],
    });
    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <Sidebar
            active={{ kind: "collection", ids: [5, 7] }}
            onSectionChange={vi.fn()}
            onCollectionSelect={vi.fn()}
            onCollectionDeleted={vi.fn()}
            onOpenSettings={vi.fn()}
          />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    expect(await screen.findByRole("button", { name: "Favorites" })).toHaveAttribute(
      "aria-current",
    );
    expect(screen.getByRole("button", { name: "Research" })).toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "All Books" })).not.toHaveAttribute("aria-current");
  });

  it("passes plain, toggle, and range gestures with the sidebar order", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 2 },
      list_books: [],
      list_collections: [
        makeCollection({ id: 5, name: "Favorites" }),
        makeCollection({ id: 7, name: "Research" }),
      ],
    });
    const onCollectionSelect = vi.fn();
    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <Sidebar
            active={{ kind: "collection", ids: [5] }}
            onSectionChange={vi.fn()}
            onCollectionSelect={onCollectionSelect}
            onCollectionDeleted={vi.fn()}
            onOpenSettings={vi.fn()}
          />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    const research = await screen.findByRole("button", { name: "Research" });
    await userEvent.click(research);
    fireEvent.click(research, { ctrlKey: true });
    fireEvent.click(research, { shiftKey: true });

    expect(onCollectionSelect).toHaveBeenNthCalledWith(1, 7, "replace", [5, 7]);
    expect(onCollectionSelect).toHaveBeenNthCalledWith(2, 7, "toggle", [5, 7]);
    expect(onCollectionSelect).toHaveBeenNthCalledWith(3, 7, "range", [5, 7]);
  });

  it("ignores modifiers on smart sections", async () => {
    const onSectionChange = vi.fn();
    const onCollectionSelect = vi.fn();
    renderSidebar(onSectionChange, vi.fn(), onCollectionSelect);

    fireEvent.click(screen.getByRole("button", { name: "Recently Added" }), {
      ctrlKey: true,
      shiftKey: true,
    });

    expect(onSectionChange).toHaveBeenCalledWith({ kind: "smart", id: "recently-added" });
    expect(onCollectionSelect).not.toHaveBeenCalled();
  });

  it("creates a collection and lands in its section", async () => {
    const onSectionChange = vi.fn();
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
      list_collections: [],
      create_collection: {
        id: 7,
        name: "To Read",
        createdAt: "2026-09-14T00:00:00.000Z",
        bookIds: [],
      },
    });
    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <Sidebar
            active={initialAppState.section}
            onSectionChange={onSectionChange}
            onCollectionSelect={vi.fn()}
            onCollectionDeleted={vi.fn()}
            onOpenSettings={vi.fn()}
          />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByTestId("new-collection-button"));
    await userEvent.type(screen.getByTestId("collection-name"), "To Read");
    await userEvent.click(screen.getByTestId("collection-create"));

    // Saving refreshes the shared collection list and navigates to the
    // fresh collection's (empty) section.
    await waitFor(() => {
      expect(onSectionChange).toHaveBeenCalledWith({ kind: "collection", ids: [7] });
    });
    expect(screen.queryByTestId("collection-dialog")).not.toBeInTheDocument();
  });

  it("reports the deleted collection so the selection is pruned", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 2 },
      list_books: [],
      list_collections: [
        { id: 5, name: "Vacation Reads", createdAt: "2026-01-01T00:00:00.000Z", bookIds: [] },
        { id: 7, name: "Research", createdAt: "2026-01-01T00:00:00.000Z", bookIds: [] },
      ],
      delete_collection: true,
    });
    const onCollectionDeleted = vi.fn();
    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <Sidebar
            active={{ kind: "collection", ids: [5, 7] }}
            onSectionChange={vi.fn()}
            onCollectionSelect={vi.fn()}
            onCollectionDeleted={onCollectionDeleted}
            onOpenSettings={vi.fn()}
          />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    expect(await screen.findByText("Vacation Reads")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("collection-delete-5"));
    await userEvent.click(await screen.findByTestId("delete-collection-confirm"));

    await waitFor(() => expect(onCollectionDeleted).toHaveBeenCalledWith(5));
  });

  it("keeps the pin state and selection when the delete fails", async () => {
    seedCollectionPreferences({ pinned: [5], pinnedOrder: [5], unpinnedOrder: [5] });
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 1 },
      list_books: [],
      list_collections: [makeCollection({ id: 5, name: "Vacation Reads" })],
      delete_collection: new Error("delete failed"),
    });
    const onCollectionDeleted = vi.fn();
    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <Sidebar
            active={{ kind: "collection", ids: [5] }}
            onSectionChange={vi.fn()}
            onCollectionSelect={vi.fn()}
            onCollectionDeleted={onCollectionDeleted}
            onOpenSettings={vi.fn()}
          />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    expect(await screen.findByText("Vacation Reads")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("collection-delete-5"));
    await userEvent.click(await screen.findByTestId("delete-collection-confirm"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("delete_collection", { collectionId: 5 }),
    );
    expect(onCollectionDeleted).not.toHaveBeenCalled();
    expect(await screen.findByTestId("delete-collection-error")).toHaveTextContent(
      "Could not delete Vacation Reads: delete failed",
    );
    expect(screen.getByTestId("delete-collection-dialog")).toBeInTheDocument();
    // The dialog is modal, so the row is aria-hidden while it stays open.
    expect(collectionRow(5).querySelector('[aria-current="true"]')).not.toBeNull();
    expect(collectionNames(screen.getByTestId("pinned-collections"))).toEqual(["Vacation Reads"]);
    const stored = JSON.parse(
      window.localStorage.getItem(COLLECTION_PREFERENCES_STORAGE_KEY)!,
    ) as CollectionPreferences;
    expect(stored.pinned).toEqual([5]);
    expect(stored.pinnedOrder).toEqual([5]);
    expect(stored.unpinnedOrder).toEqual([5]);
  });
});
