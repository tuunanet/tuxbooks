import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

import { GlobalSearch } from "@/components/search/GlobalSearch";
import { AppShell } from "@/components/layout/AppShell";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { makeBook } from "./factories";
import { invokeMock, mockInvoke } from "./mocks/tauri";

const DEEP_WATERS_HIT = {
  bookId: 2,
  title: "Deep Waters",
  author: "Moa Berg",
  snippet: "…the <em>deep</em> waters held their breath…",
};

function renderBareSearch(hits: unknown[] = [DEEP_WATERS_HIT]) {
  mockInvoke({
    get_library_stats: { bookCount: 2, collectionCount: 0 },
    list_books: [makeBook(), makeBook({ id: 2, title: "Deep Waters", author: "Moa Berg" })],
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

  it("shows an honest empty message when nothing matches", async () => {
    renderBareSearch([]);

    await userEvent.type(screen.getByTestId("global-search"), "zzz-not-here");
    expect(await screen.findByTestId("global-search-empty")).toHaveTextContent(/No books match/i);
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
