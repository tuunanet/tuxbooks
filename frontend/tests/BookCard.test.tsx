import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BookCard } from "@/components/books/BookCard";
import type { CollectionSummary } from "@/types/domain";
import { makeBook, makeCollection } from "./factories";

describe("BookCard", () => {
  it("shows title and author", () => {
    render(<BookCard book={makeBook()} collections={[]} />);
    expect(screen.getByText("A Minimal Book")).toBeInTheDocument();
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("falls back to a placeholder author", () => {
    render(<BookCard book={makeBook({ author: null })} collections={[]} />);
    expect(screen.getByText("Unknown author")).toBeInTheDocument();
  });

  it("shows a format badge for PDFs only", () => {
    const { rerender } = render(<BookCard book={makeBook({ format: "pdf" })} collections={[]} />);
    expect(screen.getByText("PDF")).toBeInTheDocument();

    rerender(<BookCard book={makeBook({ format: "epub" })} collections={[]} />);
    expect(screen.queryByText("PDF")).not.toBeInTheDocument();
  });

  it("shows a reading progress bar only when the book has progress", () => {
    const { rerender } = render(
      <BookCard book={makeBook({ progressPercent: 42 })} collections={[]} />,
    );
    expect(screen.getByRole("progressbar", { name: "Reading progress: 42%" })).toBeInTheDocument();

    rerender(<BookCard book={makeBook()} collections={[]} />);
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it("selects on a single click and marks itself pressed", () => {
    const onSelect = vi.fn();
    const { rerender } = render(
      <BookCard book={makeBook()} collections={[]} onSelect={onSelect} />,
    );

    fireEvent.click(screen.getByTestId("book-card"));
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(screen.getByTestId("book-card")).toHaveAttribute("aria-pressed", "false");

    rerender(<BookCard book={makeBook()} collections={[]} selected />);
    expect(screen.getByTestId("book-card")).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the detail view on double click", () => {
    const onOpen = vi.fn();
    render(<BookCard book={makeBook()} collections={[]} onOpen={onOpen} />);

    fireEvent.doubleClick(screen.getByTestId("book-card"));
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it("selects the book when the context menu is requested", () => {
    const onSelect = vi.fn();
    render(<BookCard book={makeBook()} collections={[]} onSelect={onSelect} />);

    fireEvent.contextMenu(screen.getByTestId("book-card"));
    expect(onSelect).toHaveBeenCalledWith(1);
  });

  it("opens the reader via Continue Reading in the context menu", async () => {
    const onRead = vi.fn();
    render(<BookCard book={makeBook()} collections={[]} onRead={onRead} />);

    fireEvent.contextMenu(screen.getByTestId("book-card"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Continue Reading" }));
    expect(onRead).toHaveBeenCalledWith(1);
  });

  it("opens the detail view via Open in the context menu", async () => {
    const onOpen = vi.fn();
    render(<BookCard book={makeBook()} collections={[]} onOpen={onOpen} />);

    fireEvent.contextMenu(screen.getByTestId("book-card"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledWith(1);
  });

  it("marks the book as finished from the context menu", async () => {
    const onMarkFinished = vi.fn();
    const { rerender } = render(
      <BookCard book={makeBook()} collections={[]} onMarkFinished={onMarkFinished} />,
    );

    fireEvent.contextMenu(screen.getByTestId("book-card"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Mark as Finished" }));
    expect(onMarkFinished).toHaveBeenCalledWith(1);

    // Already-finished books show a disabled confirmation instead.
    rerender(
      <BookCard
        book={makeBook({ progressPercent: 100 })}
        collections={[]}
        onMarkFinished={onMarkFinished}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId("book-card"));
    const finished = await screen.findByRole("menuitem", { name: "Finished" });
    expect(finished).toHaveAttribute("aria-disabled", "true");
  });

  it("keeps collection entries honest when no collections exist", async () => {
    render(<BookCard book={makeBook()} collections={[]} />);

    fireEvent.contextMenu(screen.getByTestId("book-card"));
    await screen.findByRole("menuitem", { name: "Open" });

    // Radix marks disabled div-based items with aria-disabled, not disabled.
    expect(screen.getByRole("menuitem", { name: "Open" })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("menuitem", { name: "Continue Reading" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.getByRole("menuitem", { name: "Mark as Finished" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.getByRole("menuitem", { name: "Show in File Manager" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.getByRole("menuitem", { name: "Remove from Library" })).not.toHaveAttribute(
      "aria-disabled",
    );
    const removeTrigger = screen.getByRole("menuitem", { name: "Remove from Collection" });
    expect(removeTrigger).toHaveAttribute("aria-disabled", "true");
  });

  it("adds and removes the book through the collection submenus", async () => {
    const onAddToCollection = vi.fn();
    const onRemoveFromCollection = vi.fn();
    const collections: CollectionSummary[] = [
      makeCollection({ id: 7, name: "Favorites", bookIds: [] }),
      makeCollection({ id: 9, name: "Reading", bookIds: [1] }),
    ];
    const { container } = render(
      <BookCard
        book={makeBook()}
        collections={collections}
        onAddToCollection={onAddToCollection}
        onRemoveFromCollection={onRemoveFromCollection}
      />,
    );

    // Radix closes the whole menu after a submenu selection, so each action
    // opens its own context menu.
    fireEvent.contextMenu(screen.getByTestId("book-card"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Add to Collection" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Favorites" }));
    expect(onAddToCollection).toHaveBeenCalledWith(1, 7);
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: "Add to Collection" })).not.toBeInTheDocument(),
    );

    fireEvent.contextMenu(container.querySelector("[data-book-card]")!);
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove from Collection" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Reading" }));
    expect(onRemoveFromCollection).toHaveBeenCalledWith(1, 9);
  });

  it("reveals the file via Show in File Manager", async () => {
    const onReveal = vi.fn();
    const book = makeBook();
    render(<BookCard book={book} collections={[]} onReveal={onReveal} />);

    fireEvent.contextMenu(screen.getByTestId("book-card"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Show in File Manager" }));
    expect(onReveal).toHaveBeenCalledWith(1);
  });

  it("removes the book through the context menu", async () => {
    const onRemove = vi.fn();
    render(<BookCard book={makeBook()} collections={[]} onRemove={onRemove} />);

    fireEvent.contextMenu(screen.getByTestId("book-card"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove from Library" }));
    expect(onRemove).toHaveBeenCalledWith(1);
  });

  it("shows missing-file state with recovery actions for unavailable books", async () => {
    const onLocate = vi.fn();
    const onRemove = vi.fn();
    const { rerender } = render(
      <BookCard
        book={makeBook({ available: false })}
        collections={[]}
        onLocate={onLocate}
        onRemove={onRemove}
      />,
    );

    expect(screen.getByTestId("book-card-missing")).toBeInTheDocument();
    expect(screen.getByText("Missing")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("missing-locate"));
    expect(onLocate).toHaveBeenCalledWith(1);
    await userEvent.click(screen.getByTestId("missing-remove"));
    expect(onRemove).toHaveBeenCalledWith(1);

    // Available books have no missing UI at all.
    rerender(<BookCard book={makeBook({ available: true })} collections={[]} />);
    expect(screen.queryByTestId("book-card-missing")).not.toBeInTheDocument();
  });

  it("disables Continue Reading in the context menu while the file is missing", async () => {
    const onRead = vi.fn();
    render(<BookCard book={makeBook({ available: false })} collections={[]} onRead={onRead} />);

    fireEvent.contextMenu(screen.getByTestId("book-card"));
    const continueReading = await screen.findByRole("menuitem", { name: "Continue Reading" });
    expect(continueReading).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("menuitem", { name: "Locate File…" })).not.toHaveAttribute(
      "aria-disabled",
    );
    expect(screen.getByRole("menuitem", { name: "Show in File Manager" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("shows the add-to-collection submenu as an honest shell when empty", async () => {
    render(<BookCard book={makeBook()} collections={[]} />);

    fireEvent.contextMenu(screen.getByTestId("book-card"));
    const trigger = await screen.findByRole("menuitem", { name: "Add to Collection" });
    expect(trigger).not.toHaveAttribute("aria-disabled");

    await userEvent.click(trigger);
    const noCollections = await screen.findByRole("menuitem", { name: "No collections yet" });
    expect(noCollections).toHaveAttribute("aria-disabled", "true");
  });
});
