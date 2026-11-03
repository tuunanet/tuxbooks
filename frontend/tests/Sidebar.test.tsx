import { describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Sidebar } from "@/components/layout/Sidebar";
import {
  COLLECTION_PREFERENCES_STORAGE_KEY,
  defaultCollectionPreferences,
  type CollectionPreferences,
} from "@/lib/collectionPreferences";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { initialAppState, type CollectionSelectMode, type LibrarySection } from "@/state/appState";
import type { CollectionSummary } from "@/types/domain";
import { makeBook, makeCollection } from "./factories";
import { invokeMock, mockInvoke } from "./mocks/bridge";

function renderSidebar(
  onSectionChange: (section: LibrarySection) => void,
  onOpenSettings: () => void = vi.fn(),
  onCollectionSelect: (
    collectionId: number,
    mode: CollectionSelectMode,
    visibleIds: number[],
  ) => void = vi.fn(),
) {
  mockInvoke({
    get_library_stats: { bookCount: 0, collectionCount: 0 },
    list_books: [],
    list_collections: [],
  });
  return render(
    <AppStateProvider>
      <LibraryDataProvider>
        <Sidebar
          active={initialAppState.section}
          onSectionChange={onSectionChange}
          onCollectionSelect={onCollectionSelect}
          onCollectionDeleted={vi.fn()}
          onOpenSettings={onOpenSettings}
        />
      </LibraryDataProvider>
    </AppStateProvider>,
  );
}

function seedCollectionPreferences(overrides: Partial<CollectionPreferences> = {}) {
  window.localStorage.setItem(
    COLLECTION_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ ...defaultCollectionPreferences(), ...overrides }),
  );
}

function collectionNames(group: HTMLElement): (string | null)[] {
  return within(group)
    .getAllByTestId("collection-item")
    .map((item) => item.textContent);
}

function collectionRow(collectionId: number): HTMLElement {
  const row = document.querySelector<HTMLElement>(`[data-collection-row="${collectionId}"]`);
  if (!row) throw new Error(`collection row ${collectionId} is not rendered`);
  return row;
}

/** jsdom has no elementFromPoint; the drag wiring asks it what is under the pointer. */
function stubElementFromPoint(element: HTMLElement): () => void {
  const doc = document as Document & {
    elementFromPoint?: (x: number, y: number) => Element | null;
  };
  const original = doc.elementFromPoint;
  doc.elementFromPoint = () => element;
  return () => {
    if (original) doc.elementFromPoint = original;
    else Reflect.deleteProperty(doc, "elementFromPoint");
  };
}

function renderCollectionSidebar(
  collections: CollectionSummary[],
  {
    active = initialAppState.section,
    onSectionChange = vi.fn(),
    onCollectionSelect = vi.fn(),
    onCollectionDeleted = vi.fn(),
  }: {
    active?: LibrarySection;
    onSectionChange?: (section: LibrarySection) => void;
    onCollectionSelect?: (
      collectionId: number,
      mode: CollectionSelectMode,
      visibleIds: number[],
    ) => void;
    onCollectionDeleted?: (collectionId: number) => void;
  } = {},
) {
  mockInvoke({
    get_library_stats: { bookCount: 0, collectionCount: collections.length },
    list_books: [],
    list_collections: collections,
  });
  const view = render(
    <AppStateProvider>
      <LibraryDataProvider>
        <Sidebar
          active={active}
          onSectionChange={onSectionChange}
          onCollectionSelect={onCollectionSelect}
          onCollectionDeleted={onCollectionDeleted}
          onOpenSettings={vi.fn()}
        />
      </LibraryDataProvider>
    </AppStateProvider>,
  );
  return { ...view, onSectionChange, onCollectionSelect, onCollectionDeleted };
}

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

  it("navigates to Reading history", async () => {
    const onSectionChange = vi.fn();
    renderSidebar(onSectionChange);

    await userEvent.click(screen.getByRole("button", { name: "Reading history" }));
    expect(onSectionChange).toHaveBeenCalledWith({ kind: "reading-history" });
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

    expect(onCollectionDeleted).toHaveBeenCalledWith(5);
  });
});
