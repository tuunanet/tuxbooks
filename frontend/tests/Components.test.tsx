import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { BookCard } from "@/components/books/BookCard";
import { EmptyLibraryState } from "@/components/library/EmptyLibraryState";
import { makeBook } from "./factories";

describe("BookCard", () => {
  it("shows title, author, and language", () => {
    render(<BookCard book={makeBook()} />);
    expect(screen.getByText("A Minimal Book")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(screen.getByText("en")).toBeInTheDocument();
  });

  it("falls back to a placeholder author", () => {
    render(<BookCard book={makeBook({ author: null })} />);
    expect(screen.getByText("Unknown author")).toBeInTheDocument();
  });
});

describe("EmptyLibraryState", () => {
  it("explains how to add books", () => {
    render(<EmptyLibraryState />);
    expect(screen.getByText("Your library is empty")).toBeInTheDocument();
    expect(screen.getByText(/Point tuxbooks at a folder of EPUB files/i)).toBeInTheDocument();
  });
});
