import { describe, expect, it } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BookDetail } from "@/components/books/BookDetail";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import type { BookMetadata, MetadataFields } from "@/types/domain";
import { makeBook } from "./factories";
import { invokeMock, mockInvoke } from "./mocks/bridge";

const effective = {
  title: "A Minimal Book",
  subtitle: "A Subtitle",
  publisher: "Tuxbooks Press",
  language: "en",
  isbn: "978-3-16-148410-0",
  description: "A tiny EPUB used as a test fixture.",
  publicationDate: "1843",
  series: "Analytical Engines",
  seriesIndex: 2,
  authors: ["Ada Lovelace", "Charles Babbage"],
  subjects: ["Computing"],
};

const source = {
  ...effective,
  title: "File Garbled Title",
  publisher: null,
  series: null,
  seriesIndex: null,
};

const view: BookMetadata = {
  bookId: 1,
  effective,
  source,
  overridden: {
    title: true,
    subtitle: false,
    publisher: true,
    language: false,
    isbn: false,
    description: false,
    publicationDate: false,
    series: true,
    cover: false,
    authors: false,
    subjects: false,
  },
  coverPath: null,
  sourceCoverPath: null,
};

function renderPanel(
  overrides: Record<string, unknown> = {},
  book: ReturnType<typeof makeBook> = makeBook(),
) {
  invokeMock.mockClear();
  mockInvoke({
    get_library_stats: { bookCount: 1, collectionCount: 0 },
    list_books: [book],
    get_book_metadata: view,
    ...overrides,
  });
  render(
    <AppStateProvider
      initialState={{
        view: "detail",
        section: { kind: "smart", id: "all-books" },
        selectedBookId: 1,
        detailTab: "metadata",
        libraryQuery: "",
      }}
    >
      <LibraryDataProvider>
        <BookDetail />
      </LibraryDataProvider>
    </AppStateProvider>,
  );
}

describe("MetadataPanel", () => {
  it("prefills every supported field with the effective value", async () => {
    renderPanel();

    expect(await screen.findByTestId("metadata-title")).toHaveValue("A Minimal Book");
    expect(screen.getByTestId("metadata-subtitle")).toHaveValue("A Subtitle");
    expect(screen.getByTestId("metadata-publisher")).toHaveValue("Tuxbooks Press");
    expect(screen.getByTestId("metadata-language")).toHaveValue("en");
    expect(screen.getByTestId("metadata-isbn")).toHaveValue("978-3-16-148410-0");
    expect(screen.getByTestId("metadata-date")).toHaveValue("1843");
    expect(screen.getByTestId("metadata-series")).toHaveValue("Analytical Engines");
    expect(screen.getByTestId("metadata-series-index")).toHaveValue("2");
    expect(screen.getByTestId("metadata-description")).toHaveValue(
      "A tiny EPUB used as a test fixture.",
    );
    expect(screen.getByTestId("metadata-authors-list")).toHaveTextContent("Ada Lovelace");
    expect(screen.getByTestId("metadata-subjects-list")).toHaveTextContent("Computing");
  });

  it("marks only divergent fields with the overridden dot", async () => {
    renderPanel();

    await screen.findByTestId("metadata-title");
    expect(screen.getByTestId("metadata-title-overridden")).toBeInTheDocument();
    expect(screen.getByTestId("metadata-publisher-overridden")).toBeInTheDocument();
    expect(screen.queryByTestId("metadata-subtitle-overridden")).not.toBeInTheDocument();
  });

  it("saves edited fields by writing them into the file", async () => {
    const embedded: BookMetadata = {
      ...view,
      effective: { ...effective, title: "Embedded Title" },
      source: { ...source, title: "Embedded Title" },
      overridden: {
        ...view.overridden,
        title: false,
        publisher: false,
        series: false,
      },
    };
    renderPanel({ embed_book_metadata: embedded });

    const title = await screen.findByTestId("metadata-title");
    await userEvent.clear(title);
    await userEvent.type(title, "Embedded Title");
    await userEvent.click(screen.getByTestId("metadata-panel-save"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("embed_book_metadata", {
        bookId: 1,
        form: expect.objectContaining({
          title: "Embedded Title",
          authors: ["Ada Lovelace", "Charles Babbage"],
          subjects: ["Computing"],
        }) as MetadataFields,
      }),
    );
    expect(await screen.findByTestId("metadata-panel-saved")).toHaveTextContent(
      "Saved. Written into the EPUB file.",
    );
  });

  it("keeps fields the format cannot store as library edits after saving", async () => {
    // PDF can store title, authors, and description only — the rest of the
    // saved form stays as library edits, and the confirmation says so.
    const embedded: BookMetadata = {
      ...view,
      effective: { ...effective, title: "Embedded Title" },
      source: { ...source, title: "Embedded Title" },
      overridden: {
        ...view.overridden,
        title: false,
        publisher: true,
        series: true,
      },
    };
    renderPanel({ embed_book_metadata: embedded }, makeBook({ format: "pdf" }));

    const title = await screen.findByTestId("metadata-title");
    await userEvent.clear(title);
    await userEvent.type(title, "Embedded Title");
    await userEvent.click(screen.getByTestId("metadata-panel-save"));

    expect(await screen.findByTestId("metadata-panel-saved")).toHaveTextContent(
      "Saved. Fields PDF cannot store stay as library edits.",
    );
  });

  it("surfaces a save failure inline", async () => {
    renderPanel({ embed_book_metadata: new Error("the book file is missing") });

    const title = await screen.findByTestId("metadata-title");
    await userEvent.clear(title);
    await userEvent.type(title, "Embedded Title");
    await userEvent.click(screen.getByTestId("metadata-panel-save"));

    expect(await screen.findByTestId("metadata-panel-save-error")).toHaveTextContent(/missing/i);
    expect(screen.queryByTestId("metadata-panel-saved")).not.toBeInTheDocument();
    expect(screen.getByTestId("metadata-title")).toHaveValue("Embedded Title");
  });

  it("disables Save until a field actually changes", async () => {
    renderPanel();

    // The footer renders even while the curation is still loading — wait
    // for the form itself, or the title query races the fetch and flakes
    // under load.
    await screen.findByTestId("metadata-title");
    const save = screen.getByTestId("metadata-panel-save");
    expect(save).toBeDisabled();
    await userEvent.type(screen.getByTestId("metadata-title"), "!");
    expect(save).toBeEnabled();
  });

  it("reverts unsaved edits on Cancel", async () => {
    renderPanel();

    const title = await screen.findByTestId("metadata-title");
    await userEvent.clear(title);
    await userEvent.type(title, "Changed");
    await userEvent.click(screen.getByTestId("metadata-panel-cancel"));

    expect(screen.getByTestId("metadata-title")).toHaveValue("A Minimal Book");
  });

  it("adds and removes authors through the chip editor", async () => {
    const embedded: BookMetadata = {
      ...view,
      effective: { ...effective, authors: ["Ada Lovelace", "Charles Babbage", "Grace Hopper"] },
    };
    renderPanel({ embed_book_metadata: embedded });

    await screen.findByTestId("metadata-title");
    await userEvent.type(screen.getByTestId("metadata-authors"), "Grace Hopper");
    await userEvent.click(screen.getByTestId("metadata-authors-add"));
    expect(screen.getByTestId("metadata-authors-list")).toHaveTextContent("Grace Hopper");

    await userEvent.click(screen.getByTestId("metadata-panel-save"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("embed_book_metadata", {
        bookId: 1,
        form: expect.objectContaining({
          authors: ["Ada Lovelace", "Charles Babbage", "Grace Hopper"],
        }) as MetadataFields,
      }),
    );

    await userEvent.click(screen.getByTestId("metadata-authors-remove-Charles Babbage"));
    expect(screen.getByTestId("metadata-authors-list")).not.toHaveTextContent("Charles Babbage");
  });

  it("resets library overrides to the original file values", async () => {
    const reset: BookMetadata = {
      ...view,
      effective: source,
      overridden: {
        title: false,
        subtitle: false,
        publisher: false,
        language: false,
        isbn: false,
        description: false,
        publicationDate: false,
        series: false,
        cover: false,
        authors: false,
        subjects: false,
      },
    };
    renderPanel({ reset_book_metadata: reset });

    await screen.findByTestId("metadata-title");
    await userEvent.click(screen.getByTestId("metadata-panel-reset"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("reset_book_metadata", { bookId: 1 }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("metadata-title")).toHaveValue("File Garbled Title"),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("metadata-title-overridden")).not.toBeInTheDocument(),
    );
  });

  it("keeps every field editable for PDFs and says what saving does", async () => {
    renderPanel({}, makeBook({ format: "pdf" }));

    await screen.findByTestId("metadata-title");
    for (const testId of [
      "metadata-title",
      "metadata-subtitle",
      "metadata-publisher",
      "metadata-language",
      "metadata-isbn",
      "metadata-series",
      "metadata-description",
    ]) {
      expect(screen.getByTestId(testId)).toBeEnabled();
    }
    expect(screen.getByTestId("metadata-panel")).toHaveTextContent(
      /Saving writes these values into the PDF file/i,
    );
    expect(screen.getByTestId("metadata-panel")).toHaveTextContent(
      /Other machines get them only when they receive the file/i,
    );
    const backupNote = screen.getByTestId("metadata-panel-backup-note");
    expect(backupNote).toHaveTextContent(/later saves keep it/i);
    expect(backupNote).toHaveTextContent(/deleting it there removes it on every machine/i);
    expect(backupNote).toHaveTextContent(/cannot recreate the original/i);
  });

  it("offers the library cover curation below the fields", async () => {
    renderPanel();

    expect(await screen.findByTestId("metadata-cover-change")).toBeInTheDocument();
    expect(screen.getByTestId("metadata-cover-placeholder")).toBeInTheDocument();
  });

  it("surfaces a curation-load failure", async () => {
    renderPanel({ get_book_metadata: new Error("database unavailable") });

    expect(await screen.findByTestId("metadata-panel-error")).toHaveTextContent(
      /database unavailable/i,
    );
  });
});
