import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { EmptyLibraryState } from "@/components/library/EmptyLibraryState";
import { BookCover } from "@/components/books/BookCover";
import { AppStateProvider } from "@/state/AppStateProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { makeBook } from "./factories";
import { mockInvoke } from "./mocks/bridge";

describe("EmptyLibraryState", () => {
  it("explains how to add books and offers the folder picker", () => {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
    });
    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <ImportProvider>
            <EmptyLibraryState />
          </ImportProvider>
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    expect(screen.getByText("Your library is empty")).toBeInTheDocument();
    expect(screen.getByText(/Point tuxbooks at a folder of EPUB files/i)).toBeInTheDocument();
    expect(screen.getByTestId("empty-library-import")).toHaveTextContent("Import Folder…");
  });
});

describe("BookCover", () => {
  it("falls back to the title initial without a cover file", () => {
    const { container } = render(<BookCover book={makeBook({ coverPath: null })} />);
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("renders the extracted cover through the tuxbooks protocol", () => {
    const { container } = render(
      <BookCover book={makeBook({ coverPath: "/data/covers/1.png" })} />,
    );
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("src", "tuxbooks://cover/%2Fdata%2Fcovers%2F1.png");
  });

  it("falls back to the placeholder when the cover fails to load", () => {
    const { container } = render(
      <BookCover book={makeBook({ coverPath: "/data/covers/missing.png" })} />,
    );
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByText("A")).toBeInTheDocument();
  });
});
