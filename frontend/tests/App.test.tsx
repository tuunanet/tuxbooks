import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import App from "../src/App";
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
    expect(screen.getByRole("button", { name: "Library" })).toBeInTheDocument();
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

  it("navigates to placeholder views from the sidebar", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
    });

    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Collections" }));

    expect(await screen.findByTestId("collections-view")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("get_library_stats");
  });
});
