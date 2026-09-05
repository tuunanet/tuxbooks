import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@/lib/epub/epubEngine", async () => {
  const { makeFakeEpubModule } = await import("./mocks/epubEngine");
  return makeFakeEpubModule();
});

import App from "@/App";
import { AppShell } from "@/components/layout/AppShell";
import { makeBook } from "./factories";
import { invokeMock, mockInvoke } from "./mocks/tauri";

describe("App", () => {
  it("renders the application shell with an empty library", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
    });

    render(<App />);

    const shell = await screen.findByTestId("app-shell");
    expect(shell).toBeInTheDocument();
    expect(await screen.findByTestId("sidebar")).toBeInTheDocument();
    expect(await screen.findByTestId("empty-library")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All Books" })).toBeInTheDocument();
  });

  it("renders books returned by the backend", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [makeBook(), makeBook({ id: 2, title: "Second Book", author: null })],
    });

    render(<App />);

    const cards = await screen.findAllByTestId("book-card");
    expect(cards).toHaveLength(2);
    expect(await screen.findByTestId("library-stats")).toHaveTextContent("2 books");
    expect(screen.getByText("A Minimal Book")).toBeInTheDocument();
    expect(screen.getByText("Second Book")).toBeInTheDocument();
    expect(screen.getByText("Unknown author")).toBeInTheDocument();
  });

  it("shows an error state with retry when the backend fails", async () => {
    mockInvoke({
      get_library_stats: new Error("backend exploded"),
      list_books: [],
    });

    render(<App />);

    expect(await screen.findByTestId("error-banner")).toHaveTextContent("backend exploded");

    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
    });
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("empty-library")).toBeInTheDocument();
  });

  it("navigates to the settings view from the sidebar", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Settings" }));

    expect(await screen.findByTestId("settings-view")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute("aria-current");
    expect(invokeMock).toHaveBeenCalledWith("get_library_stats");
  });

  it("hides the sidebar in the reader view and restores it on return", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
    });

    render(
      <AppShell
        initialState={{
          view: "reader",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
          metadataEditorBookId: null,
        }}
      />,
    );

    expect(await screen.findByTestId("reader-view")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar")).not.toBeInTheDocument();
    expect(screen.queryByTestId("app-shell")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Back to Library" }));
    expect(await screen.findByTestId("app-shell")).toBeInTheDocument();
    expect(await screen.findByTestId("book-card")).toBeInTheDocument();
  });

  it("switches library sections from the sidebar", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [
        makeBook(),
        makeBook({ id: 2, path: "/tmp/library/doc.pdf", format: "pdf", title: "PDF Book" }),
      ],
    });

    render(<App />);

    expect(await screen.findAllByTestId("book-card")).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "PDFs" }));

    const cards = await screen.findAllByTestId("book-card");
    expect(cards).toHaveLength(1);
    expect(screen.getByText("PDF Book")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "PDFs" })).toHaveAttribute("aria-current");
  });

  it("shows an honest placeholder for sections that need progress data", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Finished" }));

    expect(await screen.findByTestId("section-needs-progress")).toBeInTheDocument();
    expect(screen.queryByTestId("empty-library")).not.toBeInTheDocument();
  });
});
