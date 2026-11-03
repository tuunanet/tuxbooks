import { describe, expect, it, vi } from "vite-plus/test";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { GlobalSearch } from "@/components/search/GlobalSearch";
import { AppShell } from "@/components/layout/AppShell";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { makeBook, makeCollection } from "./factories";
import { invokeMock, mockInvoke } from "./mocks/bridge";

const DEEP_WATERS_HIT = {
  bookId: 2,
  title: "Deep Waters",
  author: "Moa Berg",
  snippet: "…the <em>deep</em> waters held their breath…",
};

const DEEP_RESEARCH = makeCollection({
  id: 7,
  name: "Deep Waters Research",
  bookIds: [1, 2],
});

function renderBareSearch(hits: unknown[] = [DEEP_WATERS_HIT], collections: unknown[] = []) {
  mockInvoke({
    get_library_stats: { bookCount: 2, collectionCount: collections.length },
    list_books: [makeBook(), makeBook({ id: 2, title: "Deep Waters", author: "Moa Berg" })],
    list_collections: collections,
    search_books: hits,
  });
  return render(
    <AppStateProvider>
      <LibraryDataProvider>
        <GlobalSearch />
      </LibraryDataProvider>
    </AppStateProvider>,
  );
}

describe("GlobalSearch", () => {
  it("lists backend FTS hits as a dropdown while typing", async () => {
    renderBareSearch();
    const input = screen.getByTestId("global-search");

    await userEvent.type(input, "deep");
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveAccessibleName(/Deep Waters/);
    expect(input).toHaveAttribute("aria-expanded", "true");
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("search_books", { query: "deep" }),
    );
  });

  it("shows the match snippet with the matched term emphasized", async () => {
    renderBareSearch();

    await userEvent.type(screen.getByTestId("global-search"), "deep");
    const snippet = await screen.findAllByTestId("global-search-snippet");
    expect(snippet[0]).toHaveTextContent("deep");
    const strong = snippet[0]?.querySelector("strong");
    expect(strong).toHaveTextContent("deep");
  });

  it("shows an honest empty message that names the query", async () => {
    renderBareSearch([]);

    await userEvent.type(screen.getByTestId("global-search"), "zzz-not-here");
    expect(await screen.findByTestId("global-search-empty")).toHaveTextContent(
      /No books or collections match “zzz-not-here”/i,
    );
  });

  it("clears the query and closes the dropdown on Escape", async () => {
    renderBareSearch();
    const input = screen.getByTestId("global-search");

    await userEvent.type(input, "deep");
    expect(await screen.findByRole("option")).toBeInTheDocument();

    await userEvent.type(input, "{Escape}");
    expect(input).toHaveValue("");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("opens the picked book's detail view and clears the query", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [makeBook(), makeBook({ id: 2, title: "Deep Waters", author: "Moa Berg" })],
      search_books: [DEEP_WATERS_HIT],
    });

    render(<AppShell />);

    const input = await screen.findByTestId("global-search");
    await userEvent.type(input, "waters");
    const option = await screen.findByRole("option", { name: /Deep Waters/ });
    await userEvent.click(option);

    expect(await screen.findByTestId("book-detail")).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("opens the active result with Enter", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      search_books: [
        { bookId: 1, title: makeBook().title, author: null, snippet: "<em>minimal</em> book" },
      ],
    });

    render(<AppShell />);

    const input = await screen.findByTestId("global-search");
    await userEvent.type(input, "minimal");
    await screen.findByRole("option");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByTestId("book-detail")).toBeInTheDocument();
  });

  it("queries the backend with the trimmed text", async () => {
    renderBareSearch();
    const input = screen.getByTestId("global-search");

    await userEvent.type(input, "  deep  ");
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("search_books", { query: "deep" }),
    );
  });
});

describe("GlobalSearch collections", () => {
  it("shows matching collections in a group above the books", async () => {
    renderBareSearch([DEEP_WATERS_HIT], [DEEP_RESEARCH]);

    await userEvent.type(screen.getByTestId("global-search"), "deep");

    const collections = await screen.findByRole("group", { name: "Collections" });
    expect(within(collections).getAllByRole("option")).toHaveLength(1);
    expect(within(collections).getByRole("option")).toHaveAccessibleName(/Deep Waters Research/);

    const books = await screen.findByRole("group", { name: "Books" });
    expect(within(books).getByRole("option")).toHaveAccessibleName(/Deep Waters/);
  });

  it("shows the collection's book count and the book's author as secondary metadata", async () => {
    renderBareSearch([DEEP_WATERS_HIT], [DEEP_RESEARCH]);

    await userEvent.type(screen.getByTestId("global-search"), "deep");

    const collection = await screen.findByRole("option", { name: /Deep Waters Research/ });
    expect(collection).toHaveTextContent("2 books");
    expect(within(collection).getByText("2 books")).toBeInTheDocument();
    expect(collection.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(collection.querySelector("svg")).toHaveClass("lucide-folder");

    const book = await screen.findByRole("option", { name: /Moa Berg/ });
    expect(within(book).getByText("Moa Berg")).toBeInTheDocument();
    expect(book.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(book.querySelector("svg")).toHaveClass("lucide-book-open");
  });

  it("hides a group header when that group has no matches", async () => {
    renderBareSearch([], [DEEP_RESEARCH]);

    await userEvent.type(screen.getByTestId("global-search"), "deep");

    expect(await screen.findByRole("group", { name: "Collections" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Books" })).not.toBeInTheDocument();
    expect(screen.queryByText("Books")).not.toBeInTheDocument();
  });

  it("moves one highlight across both groups and opens the book with Enter", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 1 },
      list_books: [makeBook(), makeBook({ id: 2, title: "Deep Waters", author: "Moa Berg" })],
      list_collections: [DEEP_RESEARCH],
      search_books: [DEEP_WATERS_HIT],
    });
    const { container } = render(<AppShell />);
    const input = await screen.findByTestId("global-search");

    await userEvent.type(input, "deep");
    const collection = await screen.findByRole("option", { name: /Deep Waters Research/ });
    const book = await screen.findByRole("option", { name: /Moa Berg/ });
    expect(collection).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(book).toHaveAttribute("aria-selected", "true");
    expect(collection).toHaveAttribute("aria-selected", "false");
    expect(
      container.ownerDocument.getElementById(input.getAttribute("aria-activedescendant")!),
    ).toBe(book);

    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByTestId("book-detail")).toBeInTheDocument();
  });

  it("selects a collection with Enter, replacing the current place", async () => {
    const research = makeCollection({ id: 1, name: "Research", bookIds: [1] });
    const notes = makeCollection({ id: 2, name: "Notes", bookIds: [1] });
    const favorites = makeCollection({ id: 3, name: "Favorites", bookIds: [1, 2] });
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 3 },
      list_books: [makeBook(), makeBook({ id: 2, title: "Deep Waters", author: "Moa Berg" })],
      list_collections: [favorites, notes, research],
      search_books: [],
    });

    render(<AppShell initialState={{ section: { kind: "collection", ids: [1, 2] } }} />);

    expect(await screen.findByRole("heading", { name: "Research and Notes" })).toBeInTheDocument();

    const input = screen.getByTestId("global-search");
    await userEvent.type(input, "fav");
    await screen.findByRole("option", { name: /Favorites/ });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("heading", { name: "Favorites" })).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("labels the sidebar and header searches differently", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      list_collections: [],
    });

    render(<AppShell />);

    expect(await screen.findByTestId("global-search")).toHaveAttribute(
      "placeholder",
      "Search library or collections",
    );
    expect(screen.getByTestId("global-search")).toHaveAccessibleName(
      "Search library or collections",
    );
    expect(screen.getByTestId("library-search")).toHaveAttribute("placeholder", "Filter this view");
    expect(screen.getByTestId("library-search")).toHaveAccessibleName("Filter this view");
  });
});

describe("Global search shortcut", () => {
  it("focuses the search field on Ctrl/Cmd+K", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
    });

    render(<AppShell />);
    await screen.findByTestId("app-shell");

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(screen.getByTestId("global-search")).toHaveFocus();
  });
});
