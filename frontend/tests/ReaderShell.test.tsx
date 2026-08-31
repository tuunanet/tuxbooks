import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

import { AppShell } from "@/components/layout/AppShell";
import { makeBook } from "./factories";
import { invokeMock, mockInvoke } from "./mocks/tauri";

const EPUB_CHAPTERS = ["text/chapter-one.xhtml", "text/Part_Two.xhtml"];

function renderReader(bookFormat: "epub" | "pdf" = "epub") {
  const book =
    bookFormat === "epub"
      ? makeBook()
      : makeBook({
          id: 1,
          format: "pdf",
          path: "/tmp/library/minimal.pdf",
          title: "A Minimal PDF",
        });
  invokeMock.mockClear();
  mockInvoke({
    get_library_stats: { bookCount: 1, collectionCount: 0 },
    list_books: [book],
    get_book_toc: { bookId: 1, title: book.title, chapters: EPUB_CHAPTERS },
  });
  return render(
    <AppShell
      initialState={{
        view: "reader",
        section: { kind: "smart", id: "all-books" },
        selectedBookId: 1,
        libraryQuery: "",
      }}
    />,
  );
}

async function openNavigation() {
  // fireEvent: the tooltip wrapper sets pointer-events:none on hover trails,
  // which user-event refuses to click through.
  fireEvent.click(await screen.findByTestId("reader-nav-trigger"));
  return screen.findByTestId("reader-nav");
}

describe("ReaderShell chrome", () => {
  it("renders the full-window reader without the library sidebar", async () => {
    renderReader();

    const reader = await screen.findByTestId("reader-view");
    expect(reader).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(screen.getByTestId("reader-title")).toHaveTextContent("A Minimal Book");
    expect(screen.getByTestId("reader-position")).toHaveTextContent("0%");
    expect(screen.getByTestId("epub-reader")).toBeInTheDocument();
  });

  it("returns to the library from the toolbar back button", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    await userEvent.click(screen.getByTestId("reader-back"));

    expect(await screen.findByTestId("library-view")).toBeInTheDocument();
    expect(screen.queryByTestId("reader-view")).not.toBeInTheDocument();
  });

  it("keeps the search affordance honestly disabled", async () => {
    renderReader();

    expect(await screen.findByTestId("reader-view")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search document" })).toBeDisabled();
  });
});

describe("Reader keyboard navigation", () => {
  it("moves position with arrows, space, home, and end", async () => {
    renderReader();
    await screen.findByTestId("reader-view");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByTestId("reader-position")).toHaveTextContent("25%");

    fireEvent.keyDown(window, { key: " " });
    expect(screen.getByTestId("reader-position")).toHaveTextContent("38%");

    fireEvent.keyDown(window, { key: "End" });
    expect(screen.getByTestId("reader-position")).toHaveTextContent("100%");

    fireEvent.keyDown(window, { key: "Home" });
    expect(screen.getByTestId("reader-position")).toHaveTextContent("0%");

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByTestId("reader-position")).toHaveTextContent("0%");
  });

  it("keeps position clamped to 0-100", async () => {
    renderReader();
    await screen.findByTestId("reader-view");

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByTestId("reader-position")).toHaveTextContent("0%");
  });
});

describe("Reader bookmarks", () => {
  it("toggles a session bookmark and lists it in the drawer", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    fireEvent.click(screen.getByTestId("reader-bookmark"));
    expect(screen.getByTestId("reader-bookmark")).toHaveAttribute("aria-pressed", "true");

    await openNavigation();
    await userEvent.click(await screen.findByTestId("nav-tab-bookmarks"));
    expect(await screen.findByTestId("nav-bookmark-13")).toBeInTheDocument();
    expect(screen.getByText(/session only/i)).toBeInTheDocument();

    // Close the drawer before interacting with the toolbar underneath it.
    await userEvent.keyboard("{Escape}");
    fireEvent.click(screen.getByTestId("reader-bookmark"));
    expect(screen.getByTestId("reader-bookmark")).toHaveAttribute("aria-pressed", "false");

    await openNavigation();
    await userEvent.click(await screen.findByTestId("nav-tab-bookmarks"));
    expect(await screen.findByTestId("nav-bookmarks-empty")).toBeInTheDocument();
  });
});

describe("ReaderNavigation", () => {
  it("lists EPUB contents from get_book_toc and jumps on selection", async () => {
    renderReader();

    await openNavigation();
    expect(await screen.findByTestId("toc-item-0")).toHaveTextContent("chapter one");
    expect(screen.getByTestId("toc-item-1")).toHaveTextContent("Part Two");
    expect(invokeMock).toHaveBeenCalledWith("get_book_toc", { bookId: 1 });

    await userEvent.click(screen.getByTestId("toc-item-1"));
    expect(await screen.findByTestId("reader-position")).toHaveTextContent("50%");
    expect(screen.queryByTestId("reader-nav")).not.toBeInTheDocument();
  });

  it("reports an honest error when contents fail to load", async () => {
    renderReader();
    await screen.findByTestId("reader-view");

    // Override after renderReader, which installs the happy-path routes.
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_book_toc") {
        return Promise.reject(new Error("file went away"));
      }
      return command === "get_library_stats"
        ? Promise.resolve({ bookCount: 1, collectionCount: 0 })
        : Promise.resolve([makeBook()]);
    });

    await openNavigation();

    expect(await screen.findByTestId("toc-error")).toHaveTextContent(
      "Contents could not be loaded: file went away",
    );
  });

  it("gives PDFs Pages and an honest Outline instead of EPUB contents", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-reader");

    await openNavigation();
    expect(await screen.findByTestId("nav-pages")).toBeInTheDocument();
    expect(screen.getByTestId("nav-page-24")).toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("get_book_toc", { bookId: 1 });

    await userEvent.click(screen.getByTestId("nav-page-12"));
    expect(await screen.findByTestId("reader-position")).toHaveTextContent("48%");

    // Re-open for the Outline tab (Radix unmounts inactive tab content).
    await openNavigation();
    await userEvent.click(await screen.findByTestId("nav-tab-outline"));
    expect(await screen.findByTestId("nav-outline")).toHaveTextContent(/real PDF renderer/i);
  });

  it("shows the pdf page counter following the reading position", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-reader");

    fireEvent.keyDown(window, { key: "End" });
    expect(screen.getByTestId("pdf-reader")).toHaveTextContent("Page 24 of 24");
  });
});

describe("ReaderAppearance", () => {
  it("changes the reader theme and layout", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    const content = await screen.findByTestId("appearance-content");
    expect(content).toBeInTheDocument();

    // Radix toggle groups inside the popover render radio semantics.
    await userEvent.click(screen.getByRole("radio", { name: "Paper" }));
    expect(screen.getByTestId("reader-view")).toHaveAttribute("data-theme", "paper");

    await userEvent.click(screen.getByRole("radio", { name: "Scrolling" }));
    expect(await screen.findByTestId("epub-reader")).toHaveAttribute("data-layout", "scrolling");
    // Scrolling mode shows every placeholder page at once.
    expect(screen.getAllByTestId("epub-page")).toHaveLength(8);
  });

  it("exposes font size and line spacing sliders", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    const content = await screen.findByTestId("appearance-content");

    expect(content).toHaveTextContent("Font size");
    expect(content).toHaveTextContent("17px");
    expect(content).toHaveTextContent("Line spacing");
    expect(content).toHaveTextContent("1.6");
    expect(screen.getByLabelText("Font size")).toBeInTheDocument();
    expect(screen.getByLabelText("Line spacing")).toBeInTheDocument();
  });
});
