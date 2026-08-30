import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

import { LibraryView } from "@/components/library/LibraryView";
import { AppShell } from "@/components/layout/AppShell";
import { AppStateProvider } from "@/state/AppStateProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import type { LibrarySection } from "@/state/appState";
import { makeBook } from "./factories";
import { mockInvoke } from "./mocks/tauri";

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
      initialState={{ view: "library", section, selectedBookId: null, libraryQuery: "" }}
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
    expect(await screen.findByTestId("book-detail-placeholder")).toBeInTheDocument();
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
    expect(await screen.findByTestId("book-detail-placeholder")).toBeInTheDocument();
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
