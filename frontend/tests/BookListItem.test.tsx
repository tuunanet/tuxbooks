import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { BookListItem } from "@/components/books/BookListItem";
import { makeBook } from "./factories";

describe("BookListItem", () => {
  it("shows a format tag for both EPUB and PDF books", () => {
    const { rerender } = render(
      <BookListItem book={makeBook({ format: "epub" })} collections={[]} />,
    );
    expect(screen.getByText("EPUB")).toBeInTheDocument();

    rerender(<BookListItem book={makeBook({ format: "pdf" })} collections={[]} />);
    expect(screen.getByText("PDF")).toBeInTheDocument();
  });

  it("shows a progress bar half the grid card's width for books being read", () => {
    render(<BookListItem book={makeBook({ progressPercent: 65 })} collections={[]} />);
    // The grid card's bar spans the card's text area (~144px at the minimal
    // 160px column); the list column pins it to half of that. The width
    // lives on the fixed-size slot, the bar fills it.
    const bar = screen.getByRole("progressbar", { name: "Reading progress: 65%" });
    expect(bar).toBeInTheDocument();
    expect(bar.parentElement).toHaveClass("w-[72px]");
  });

  it("says Not started for unread books and Finished for finished ones", () => {
    const { rerender } = render(<BookListItem book={makeBook()} collections={[]} />);
    expect(screen.getByText("Not started")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    rerender(<BookListItem book={makeBook({ progressPercent: 100 })} collections={[]} />);
    expect(screen.getByText("Finished")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});
