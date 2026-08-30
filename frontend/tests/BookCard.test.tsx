import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BookCard } from "@/components/books/BookCard";
import { makeBook } from "./factories";

describe("BookCard", () => {
  it("shows title and author", () => {
    render(<BookCard book={makeBook()} />);
    expect(screen.getByText("A Minimal Book")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("falls back to a placeholder author", () => {
    render(<BookCard book={makeBook({ author: null })} />);
    expect(screen.getByText("Unknown author")).toBeInTheDocument();
  });

  it("shows a format badge for PDFs only", () => {
    const { rerender } = render(<BookCard book={makeBook({ format: "pdf" })} />);
    expect(screen.getByText("PDF")).toBeInTheDocument();

    rerender(<BookCard book={makeBook({ format: "epub" })} />);
    expect(screen.queryByText("PDF")).not.toBeInTheDocument();
  });

  it("shows a reading progress bar only when progress data exists", () => {
    const { rerender } = render(
      <BookCard
        book={makeBook()}
        progress={{ kind: "epub", cfi: "epubcfi(/6/4!/4/2)", percentage: 42 }}
      />,
    );
    expect(screen.getByRole("progressbar", { name: "Reading progress: 42%" })).toBeInTheDocument();

    rerender(<BookCard book={makeBook()} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("selects on a single click and marks itself pressed", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<BookCard book={makeBook()} onSelect={onSelect} />);

    fireEvent.click(screen.getByTestId("book-card"));
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(screen.getByTestId("book-card")).toHaveAttribute("aria-pressed", "false");

    rerender(<BookCard book={makeBook()} selected />);
    expect(screen.getByTestId("book-card")).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the detail view on double click", () => {
    const onOpen = vi.fn();
    render(<BookCard book={makeBook()} onOpen={onOpen} />);

    fireEvent.doubleClick(screen.getByTestId("book-card"));
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it("selects the book when the context menu is requested", () => {
    const onSelect = vi.fn();
    render(<BookCard book={makeBook()} onSelect={onSelect} />);

    fireEvent.contextMenu(screen.getByTestId("book-card"));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("opens the reader via Continue Reading in the context menu", async () => {
    const onRead = vi.fn();
    render(<BookCard book={makeBook()} onRead={onRead} />);

    fireEvent.contextMenu(screen.getByTestId("book-card"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Continue Reading" }));
    expect(onRead).toHaveBeenCalledWith(1);
  });

  it("opens the detail view via Open in the context menu", async () => {
    const onOpen = vi.fn();
    render(<BookCard book={makeBook()} onOpen={onOpen} />);

    fireEvent.contextMenu(screen.getByTestId("book-card"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it("keeps backend-less actions as disabled placeholders", async () => {
    render(<BookCard book={makeBook()} />);

    fireEvent.contextMenu(screen.getByTestId("book-card"));
    await screen.findByRole("menuitem", { name: "Open" });

    for (const name of [
      "Add to Collection",
      "Mark as Finished",
      "Edit Metadata",
      "Show in File Manager",
      "Remove from Library",
    ]) {
      // Radix marks disabled div-based items with aria-disabled, not disabled.
      expect(screen.getByRole("menuitem", { name })).toHaveAttribute("aria-disabled", "true");
    }
    const open = screen.getByRole("menuitem", { name: "Open" });
    expect(open).not.toHaveAttribute("aria-disabled");
    const continueReading = screen.getByRole("menuitem", { name: "Continue Reading" });
    expect(continueReading).not.toHaveAttribute("aria-disabled");
  });
});
