import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Sidebar } from "@/components/layout/Sidebar";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { initialAppState, type LibrarySection } from "@/state/appState";
import { makeBook } from "./factories";
import { mockInvoke } from "./mocks/bridge";

function renderSidebar(onSectionChange: (section: LibrarySection) => void) {
  mockInvoke({
    get_library_stats: { bookCount: 0, collectionCount: 0 },
    list_books: [],
    list_collections: [],
  });
  return render(
    <AppStateProvider>
      <LibraryDataProvider>
        <Sidebar active={initialAppState.section} onSectionChange={onSectionChange} />
      </LibraryDataProvider>
    </AppStateProvider>,
  );
}

describe("Sidebar", () => {
  it("renders the navigation groups and items", () => {
    renderSidebar(vi.fn());

    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByText("Library")).toBeInTheDocument();
    expect(screen.getByText("Collections")).toBeInTheDocument();
    for (const label of [
      "All Books",
      "EPUBs",
      "PDFs",
      "Recently Added",
      "Recently Read",
      "In Progress",
      "Finished",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    // No loose book is loaded, so the loose-books view stays hidden.
    expect(
      screen.queryByRole("button", { name: "Outside Watched Folders" }),
    ).not.toBeInTheDocument();
  });

  it("shows the loose-books item only when a loose book is loaded", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook({ id: 1, title: "Dropped In", loose: true })],
      list_collections: [],
    });
    const onSectionChange = vi.fn();
    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <Sidebar active={initialAppState.section} onSectionChange={onSectionChange} />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    const item = await screen.findByRole("button", { name: "Outside Watched Folders" });
    await userEvent.click(item);
    expect(onSectionChange).toHaveBeenCalledWith({ kind: "smart", id: "outside-watched" });
  });

  it("marks the active section and updates on click", async () => {
    const onSectionChange = vi.fn();
    renderSidebar(onSectionChange);

    const allBooks = screen.getByRole("button", { name: "All Books" });
    expect(allBooks).toHaveAttribute("aria-current");

    await userEvent.click(screen.getByRole("button", { name: "Recently Added" }));
    expect(onSectionChange).toHaveBeenCalledWith({ kind: "smart", id: "recently-added" });
  });

  it("navigates to settings", async () => {
    const onSectionChange = vi.fn();
    renderSidebar(onSectionChange);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onSectionChange).toHaveBeenCalledWith({ kind: "settings" });
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

  it("lists collections as clickable sections", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 1 },
      list_books: [],
      list_collections: [
        { id: 5, name: "Vacation Reads", createdAt: "2026-01-01T00:00:00.000Z", bookIds: [] },
      ],
    });
    const onSectionChange = vi.fn();
    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <Sidebar active={initialAppState.section} onSectionChange={onSectionChange} />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    expect(await screen.findByText("Vacation Reads")).toBeInTheDocument();

    await userEvent.click(screen.getByText("Vacation Reads"));
    expect(onSectionChange).toHaveBeenCalledWith({ kind: "collection", id: 5 });
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
          <Sidebar active={initialAppState.section} onSectionChange={onSectionChange} />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    await userEvent.click(screen.getByTestId("new-collection-button"));
    await userEvent.type(screen.getByTestId("collection-name"), "To Read");
    await userEvent.click(screen.getByTestId("collection-create"));

    // Saving refreshes the shared collection list and navigates to the
    // fresh collection's (empty) section.
    await waitFor(() => {
      expect(onSectionChange).toHaveBeenCalledWith({ kind: "collection", id: 7 });
    });
    expect(screen.queryByTestId("collection-dialog")).not.toBeInTheDocument();
  });

  it("deleting the active collection falls back to All Books", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 1 },
      list_books: [],
      list_collections: [
        { id: 5, name: "Vacation Reads", createdAt: "2026-01-01T00:00:00.000Z", bookIds: [] },
      ],
      delete_collection: true,
    });
    const onSectionChange = vi.fn();
    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <Sidebar active={{ kind: "collection", id: 5 }} onSectionChange={onSectionChange} />
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    expect(await screen.findByText("Vacation Reads")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("collection-delete-5"));
    await waitFor(() => {
      expect(onSectionChange).toHaveBeenCalledWith({ kind: "smart", id: "all-books" });
    });
  });
});
