import { describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Sidebar } from "@/components/layout/Sidebar";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { type CollectionPreferences } from "@/lib/collectionPreferences";
import { makeCollection } from "./factories";
import { invokeMock, mockInvoke } from "./mocks/bridge";
import {
  COLLECTION_PREFERENCES_STORAGE_KEY,
  collectionNames,
  collectionRow,
  renderCollectionSidebar,
  renderSidebar,
  seedCollectionPreferences,
  stubElementFromPoint,
} from "./sidebarHelpers";

describe("Sidebar collection groups", () => {
  it("groups collections into pinned and unpinned rows in stored order", async () => {
    seedCollectionPreferences({ pinned: [1, 3], pinnedOrder: [1, 3] });
    renderCollectionSidebar([
      makeCollection({ id: 1, name: "Zebra" }),
      makeCollection({ id: 2, name: "alpha" }),
      makeCollection({ id: 3, name: "Beta" }),
    ]);

    expect(await screen.findByText("Pinned Collections")).toBeInTheDocument();
    expect(collectionNames(screen.getByTestId("pinned-collections"))).toEqual(["Zebra", "Beta"]);
    expect(collectionNames(screen.getByTestId("unpinned-collections"))).toEqual(["alpha"]);
    expect(screen.getByRole("button", { name: "Unpinned Collections (1)" })).toBeInTheDocument();
  });

  it("hides a group label when that group is empty", async () => {
    renderCollectionSidebar([makeCollection({ id: 1, name: "Zebra" })]);

    expect(await screen.findByText("Zebra")).toBeInTheDocument();
    expect(screen.queryByText("Pinned Collections")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpinned Collections (1)" })).toBeInTheDocument();
  });

  it("hides both collection labels when the library has no collections", async () => {
    renderSidebar(vi.fn());

    await screen.findByRole("button", { name: "All Books" });
    expect(screen.queryByText("Pinned Collections")).not.toBeInTheDocument();
    expect(screen.queryByText(/Unpinned Collections/)).not.toBeInTheDocument();
  });

  it("pins the invoked row, keeps the whole selection, and persists the pin", async () => {
    const { onCollectionSelect } = renderCollectionSidebar(
      [makeCollection({ id: 5, name: "Favorites" }), makeCollection({ id: 7, name: "Research" })],
      { active: { kind: "collection", ids: [5, 7] } },
    );

    await userEvent.click(await screen.findByTestId("collection-actions-5"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Pin" }));

    expect(screen.getByRole("button", { name: "Favorites" })).toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "Research" })).toHaveAttribute("aria-current");
    expect(collectionNames(screen.getByTestId("pinned-collections"))).toEqual(["Favorites"]);
    expect(onCollectionSelect).not.toHaveBeenCalled();
    expect(
      JSON.parse(window.localStorage.getItem(COLLECTION_PREFERENCES_STORAGE_KEY)!).pinned,
    ).toEqual([5]);
  });

  it("unpins a collection back into the unpinned group", async () => {
    seedCollectionPreferences({ pinned: [5], pinnedOrder: [5] });
    renderCollectionSidebar([makeCollection({ id: 5, name: "Favorites" })]);

    await userEvent.click(await screen.findByTestId("collection-actions-5"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Unpin" }));

    expect(screen.queryByText("Pinned Collections")).not.toBeInTheDocument();
    expect(collectionNames(screen.getByTestId("unpinned-collections"))).toEqual(["Favorites"]);
    expect(
      JSON.parse(window.localStorage.getItem(COLLECTION_PREFERENCES_STORAGE_KEY)!).pinned,
    ).toEqual([]);
  });

  it("moves a row with keyboard-only menu actions and disables the edges", async () => {
    renderCollectionSidebar([
      makeCollection({ id: 1, name: "Zebra" }),
      makeCollection({ id: 2, name: "alpha" }),
      makeCollection({ id: 3, name: "Beta" }),
    ]);

    const betaActions = await screen.findByTestId("collection-actions-3");
    betaActions.focus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{Enter}");
    expect(collectionNames(screen.getByTestId("unpinned-collections"))).toEqual([
      "Beta",
      "alpha",
      "Zebra",
    ]);

    await userEvent.click(screen.getByTestId("collection-actions-3"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Move down" }));
    expect(collectionNames(screen.getByTestId("unpinned-collections"))).toEqual([
      "alpha",
      "Beta",
      "Zebra",
    ]);

    // At the top of its group Move up has nowhere to go.
    await userEvent.click(screen.getByTestId("collection-actions-2"));
    expect(await screen.findByRole("menuitem", { name: "Move up" })).toHaveAttribute(
      "data-disabled",
    );
  });

  it("collapses Unpinned, hides its rows, and remembers the choice", async () => {
    const first = renderCollectionSidebar([makeCollection({ id: 5, name: "Favorites" })]);
    await screen.findByText("Favorites");

    const toggle = screen.getByRole("button", { name: "Unpinned Collections (1)" });
    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Favorites")).not.toBeInTheDocument();
    expect(
      JSON.parse(window.localStorage.getItem(COLLECTION_PREFERENCES_STORAGE_KEY)!)
        .unpinnedCollapsed,
    ).toBe(true);

    first.unmount();
    const view = renderCollectionSidebar([makeCollection({ id: 5, name: "Favorites" })]);
    const collapsed = await screen.findByRole("button", { name: "Unpinned Collections (1)" });
    expect(collapsed).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Favorites")).not.toBeInTheDocument();

    await userEvent.click(collapsed);
    expect(view.getByText("Favorites")).toBeInTheDocument();
  });

  it("passes the grouped order to collection selection gestures", async () => {
    seedCollectionPreferences({ pinned: [3], pinnedOrder: [3] });
    const { onCollectionSelect } = renderCollectionSidebar([
      makeCollection({ id: 1, name: "Zebra" }),
      makeCollection({ id: 2, name: "alpha" }),
      makeCollection({ id: 3, name: "Beta" }),
    ]);

    await userEvent.click(await screen.findByRole("button", { name: "Zebra" }));

    // Pinned comes first, then the alphabetical Unpinned group.
    expect(onCollectionSelect).toHaveBeenCalledWith(1, "replace", [3, 2, 1]);
  });

  it("leaves collapsed Unpinned rows out of a new selection range", async () => {
    seedCollectionPreferences({ pinned: [3], pinnedOrder: [3], unpinnedCollapsed: true });
    const { onCollectionSelect } = renderCollectionSidebar([
      makeCollection({ id: 1, name: "Zebra" }),
      makeCollection({ id: 2, name: "alpha" }),
      makeCollection({ id: 3, name: "Beta" }),
    ]);

    await userEvent.click(await screen.findByRole("button", { name: "Beta" }));

    expect(onCollectionSelect).toHaveBeenCalledWith(3, "replace", [3]);
  });

  it("sanitizes corrupt and stale stored preferences", async () => {
    window.localStorage.setItem(COLLECTION_PREFERENCES_STORAGE_KEY, "{ not json");
    const corrupt = renderCollectionSidebar([makeCollection({ id: 1, name: "Zebra" })]);
    expect(await screen.findByText("Zebra")).toBeInTheDocument();
    expect(screen.queryByText("Pinned Collections")).not.toBeInTheDocument();
    corrupt.unmount();

    seedCollectionPreferences({ pinned: [99, 2], pinnedOrder: [99, 2] });
    renderCollectionSidebar([
      makeCollection({ id: 1, name: "Zebra" }),
      makeCollection({ id: 2, name: "alpha" }),
    ]);
    expect(await screen.findByText("Pinned Collections")).toBeInTheDocument();
    expect(collectionNames(screen.getByTestId("pinned-collections"))).toEqual(["alpha"]);
    expect(collectionNames(screen.getByTestId("unpinned-collections"))).toEqual(["Zebra"]);
  });

  it("drops a deleted collection from the stored preferences after confirmation", async () => {
    seedCollectionPreferences({ pinned: [5], pinnedOrder: [5], unpinnedOrder: [5] });
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 1 },
      list_books: [],
      list_collections: [makeCollection({ id: 5, name: "Vacation Reads" })],
      delete_collection: true,
    });
    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <Sidebar
            active={{ kind: "collection", ids: [5] }}
            onSectionChange={vi.fn()}
            onCollectionSelect={vi.fn()}
            onCollectionDeleted={vi.fn()}
            onOpenSettings={vi.fn()}
          />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    expect(await screen.findByText("Vacation Reads")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("collection-delete-5"));

    const dialog = await screen.findByTestId("delete-collection-dialog");
    expect(dialog).toHaveTextContent("Delete Vacation Reads?");
    expect(dialog).toHaveTextContent(/books stay in the library/i);
    await userEvent.click(screen.getByTestId("delete-collection-confirm"));

    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem(COLLECTION_PREFERENCES_STORAGE_KEY)!,
      ) as CollectionPreferences;
      expect(stored.pinned).toEqual([]);
      expect(stored.pinnedOrder).toEqual([]);
      expect(stored.unpinnedOrder).toEqual([]);
    });
    // The now-empty Pinned group label does not linger.
    await waitFor(() => expect(screen.queryByTestId("pinned-collections")).not.toBeInTheDocument());
  });

  it("cancels a delete confirmation without touching the collection", async () => {
    const { onCollectionDeleted } = renderCollectionSidebar([
      makeCollection({ id: 5, name: "Vacation Reads" }),
    ]);
    await screen.findByText("Vacation Reads");

    await userEvent.click(screen.getByTestId("collection-delete-5"));
    await screen.findByTestId("delete-collection-dialog");
    await userEvent.click(screen.getByTestId("delete-collection-cancel"));

    await waitFor(() =>
      expect(screen.queryByTestId("delete-collection-dialog")).not.toBeInTheDocument(),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("delete_collection", expect.anything());
    expect(onCollectionDeleted).not.toHaveBeenCalled();
  });

  it("closes a delete confirmation with Escape", async () => {
    const { onCollectionDeleted } = renderCollectionSidebar([
      makeCollection({ id: 5, name: "Vacation Reads" }),
    ]);
    await screen.findByText("Vacation Reads");

    await userEvent.click(screen.getByTestId("collection-delete-5"));
    await screen.findByTestId("delete-collection-dialog");
    await userEvent.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByTestId("delete-collection-dialog")).not.toBeInTheDocument(),
    );
    expect(onCollectionDeleted).not.toHaveBeenCalled();
  });

  it("renames a collection from the row actions menu in a multi-selection", async () => {
    const responses: Record<string, unknown> = {
      get_library_stats: { bookCount: 0, collectionCount: 2 },
      list_books: [],
      list_collections: [
        makeCollection({ id: 5, name: "Favorites" }),
        makeCollection({ id: 7, name: "Research" }),
      ],
      rename_collection: makeCollection({ id: 5, name: "Keepers" }),
    };
    mockInvoke(responses);
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

    await screen.findByText("Favorites");
    await userEvent.click(screen.getByTestId("collection-actions-5"));
    await userEvent.click(await screen.findByTestId("collection-rename-5"));

    const input = await screen.findByTestId("collection-name");
    expect(input).toHaveValue("Favorites");
    responses.list_collections = [
      makeCollection({ id: 5, name: "Keepers" }),
      makeCollection({ id: 7, name: "Research" }),
    ];
    await userEvent.clear(input);
    await userEvent.type(input, "Keepers{Enter}");

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("rename_collection", {
        collectionId: 5,
        name: "Keepers",
      }),
    );
    expect(await screen.findByText("Keepers")).toBeInTheDocument();
    expect(screen.getByText("Research")).toBeInTheDocument();
    expect(screen.queryByTestId("collection-dialog")).not.toBeInTheDocument();
  });

  it("opens the row actions from a right-click", async () => {
    renderCollectionSidebar([makeCollection({ id: 5, name: "Favorites" })]);
    await screen.findByText("Favorites");

    fireEvent.contextMenu(collectionRow(5));

    expect(await screen.findByRole("menuitem", { name: "Pin" })).toBeInTheDocument();
  });

  it("wires pointer dragging to a reorder inside the group", async () => {
    renderCollectionSidebar([
      makeCollection({ id: 1, name: "Zebra" }),
      makeCollection({ id: 2, name: "alpha" }),
      makeCollection({ id: 3, name: "Beta" }),
    ]);
    await screen.findByText("Zebra");
    const restoreElementFromPoint = stubElementFromPoint(collectionRow(1));

    const handle = screen.getByTestId("collection-drag-2");
    fireEvent.pointerDown(handle, {
      button: 0,
      clientX: 10,
      clientY: 10,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(handle, {
      clientX: 10,
      clientY: 80,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(handle, {
      button: 0,
      clientX: 10,
      clientY: 80,
      pointerId: 1,
      pointerType: "mouse",
    });

    // alpha starts first and is dropped after Zebra, the group's last row.
    expect(collectionNames(screen.getByTestId("unpinned-collections"))).toEqual([
      "Beta",
      "Zebra",
      "alpha",
    ]);
    restoreElementFromPoint();
  });

  it("wires dragging across the group boundary to pin the row", async () => {
    seedCollectionPreferences({ pinned: [1], pinnedOrder: [1] });
    renderCollectionSidebar([
      makeCollection({ id: 1, name: "Zebra" }),
      makeCollection({ id: 2, name: "alpha" }),
      makeCollection({ id: 3, name: "Beta" }),
    ]);
    await screen.findByText("Zebra");
    const restoreElementFromPoint = stubElementFromPoint(collectionRow(1));

    const handle = screen.getByTestId("collection-drag-2");
    fireEvent.pointerDown(handle, {
      button: 0,
      clientX: 10,
      clientY: 10,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(handle, {
      clientX: 10,
      clientY: 80,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerUp(handle, {
      button: 0,
      clientX: 10,
      clientY: 80,
      pointerId: 1,
      pointerType: "mouse",
    });

    expect(collectionNames(screen.getByTestId("pinned-collections"))).toEqual(["Zebra", "alpha"]);
    expect(collectionNames(screen.getByTestId("unpinned-collections"))).toEqual(["Beta"]);
    restoreElementFromPoint();
  });

  it("cancels a drag without changing the order", async () => {
    renderCollectionSidebar([
      makeCollection({ id: 1, name: "Zebra" }),
      makeCollection({ id: 2, name: "alpha" }),
    ]);
    await screen.findByText("Zebra");
    const restoreElementFromPoint = stubElementFromPoint(collectionRow(1));

    const handle = screen.getByTestId("collection-drag-2");
    fireEvent.pointerDown(handle, {
      button: 0,
      clientX: 10,
      clientY: 10,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerMove(handle, {
      clientX: 10,
      clientY: 80,
      pointerId: 1,
      pointerType: "mouse",
    });
    fireEvent.pointerCancel(handle, { pointerId: 1, pointerType: "mouse" });

    expect(collectionNames(screen.getByTestId("unpinned-collections"))).toEqual(["alpha", "Zebra"]);
    restoreElementFromPoint();
  });
});
