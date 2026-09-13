import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  fieldSources: {
    title: null,
    subtitle: null,
    publisher: null,
    language: null,
    isbn: null,
    description: null,
    publicationDate: null,
    series: null,
    authors: null,
    subjects: null,
  },
};

const fileProperties = {
  bookId: 1,
  format: "epub" as const,
  entries: [
    { key: "Title", value: "File Garbled Title" },
    { key: "Creator", value: "Microsoft Word" },
  ],
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
    get_book_file_properties: fileProperties,
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

  it("marks only divergent fields and shows the file's own value", async () => {
    renderPanel();

    await screen.findByTestId("metadata-title");
    expect(screen.getByTestId("metadata-title-overridden")).toBeInTheDocument();
    expect(screen.getByTestId("metadata-publisher-overridden")).toBeInTheDocument();
    expect(screen.queryByTestId("metadata-subtitle-overridden")).not.toBeInTheDocument();
    expect(screen.getByTestId("metadata-title").closest("div")).toHaveTextContent(
      "File Garbled Title",
    );
  });

  it("saves edited fields and shows the saved confirmation", async () => {
    const saved: BookMetadata = {
      ...view,
      effective: { ...effective, title: "Curated Title" },
    };
    renderPanel({ update_book_metadata: saved });

    const title = await screen.findByTestId("metadata-title");
    await userEvent.clear(title);
    await userEvent.type(title, "Curated Title");
    await userEvent.click(screen.getByTestId("metadata-panel-save"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_book_metadata", {
        bookId: 1,
        form: expect.objectContaining({
          title: "Curated Title",
          authors: ["Ada Lovelace", "Charles Babbage"],
          subjects: ["Computing"],
        }) as MetadataFields,
      }),
    );
    expect(await screen.findByTestId("metadata-panel-saved")).toHaveTextContent(/saved/i);
  });

  it("disables Save until a field actually changes", async () => {
    renderPanel();

    const save = await screen.findByTestId("metadata-panel-save");
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
    const saved: BookMetadata = {
      ...view,
      effective: { ...effective, authors: ["Ada Lovelace", "Charles Babbage", "Grace Hopper"] },
    };
    renderPanel({ update_book_metadata: saved });

    await screen.findByTestId("metadata-title");
    await userEvent.type(screen.getByTestId("metadata-authors"), "Grace Hopper");
    await userEvent.click(screen.getByTestId("metadata-authors-add"));
    expect(screen.getByTestId("metadata-authors-list")).toHaveTextContent("Grace Hopper");

    await userEvent.click(screen.getByTestId("metadata-panel-save"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_book_metadata", {
        bookId: 1,
        form: expect.objectContaining({
          authors: ["Ada Lovelace", "Charles Babbage", "Grace Hopper"],
        }) as MetadataFields,
      }),
    );

    await userEvent.click(screen.getByTestId("metadata-authors-remove-Charles Babbage"));
    expect(screen.getByTestId("metadata-authors-list")).not.toHaveTextContent("Charles Babbage");
  });

  it("shows the native file properties read from disk", async () => {
    renderPanel();

    const list = await screen.findByTestId("file-properties-list");
    expect(list).toHaveTextContent("File Garbled Title");
    expect(list).toHaveTextContent("Microsoft Word");
  });

  it("resets library overrides to the source values", async () => {
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

  it("persists a per-field library-vs-file choice", async () => {
    const withFileSource: BookMetadata = {
      ...view,
      effective: { ...effective, title: source.title },
      fieldSources: { ...view.fieldSources, title: "file" },
    };
    renderPanel({ set_metadata_field_source: withFileSource });

    const titleField = (await screen.findByTestId("metadata-title")).closest("div");
    expect(titleField).not.toBeNull();
    await userEvent.click(within(titleField!).getByRole("button", { name: "Use file value" }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("set_metadata_field_source", {
        bookId: 1,
        field: "title",
        source: "file",
      }),
    );
    // The effective title becomes the file's, and the control flips.
    await waitFor(() =>
      expect(screen.getByTestId("metadata-title")).toHaveValue("File Garbled Title"),
    );
    const flipped = screen.getByTestId("metadata-title").closest("div");
    expect(within(flipped!).getByTestId("metadata-source-file")).toBeInTheDocument();

    await userEvent.click(within(flipped!).getByRole("button", { name: "Use library value" }));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("set_metadata_field_source", {
        bookId: 1,
        field: "title",
        source: "library",
      }),
    );
  });

  it("surfaces a file-properties read failure honestly", async () => {
    renderPanel({ get_book_file_properties: new Error("the book file is missing") });

    expect(await screen.findByTestId("file-properties-error")).toHaveTextContent(/missing/i);
  });

  it("surfaces a curation-load failure", async () => {
    renderPanel({ get_book_metadata: new Error("database unavailable") });

    expect(await screen.findByTestId("metadata-panel-error")).toHaveTextContent(
      /database unavailable/i,
    );
  });

  it("gates the File Metadata tab to what the format can store", async () => {
    renderPanel({}, makeBook({ format: "pdf" }));
    await screen.findByTestId("metadata-title");
    await userEvent.click(screen.getByTestId("metadata-tab-file"));

    expect(screen.getByTestId("metadata-title")).toBeEnabled();
    expect(screen.getByTestId("metadata-description")).toBeEnabled();
    expect(screen.getByTestId("metadata-subtitle")).toBeDisabled();
    expect(screen.getByTestId("metadata-series")).toBeDisabled();
    expect(screen.getByTestId("metadata-subtitle-library-only")).toBeInTheDocument();
    expect(screen.queryByTestId("metadata-title-library-only")).not.toBeInTheDocument();
  });

  it("embeds edited file metadata through the File Metadata tab", async () => {
    const embedded: BookMetadata = {
      ...view,
      effective: { ...effective, title: "Embedded Title" },
      source: { ...source, title: "Embedded Title" },
      overridden: { ...view.overridden, title: false, publisher: false, series: false },
    };
    renderPanel({ embed_book_metadata: embedded });

    const title = await screen.findByTestId("metadata-title");
    await userEvent.clear(title);
    await userEvent.type(title, "Embedded Title");
    await userEvent.click(screen.getByTestId("metadata-tab-file"));
    await userEvent.click(screen.getByTestId("metadata-panel-embed"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("embed_book_metadata", {
        bookId: 1,
        form: expect.objectContaining({ title: "Embedded Title" }),
      }),
    );
    expect(await screen.findByTestId("metadata-panel-embed-success")).toHaveTextContent(
      "Written into the EPUB file.",
    );
  });

  it("writes to the file from the Library tab when the checkbox is on", async () => {
    const embedded: BookMetadata = {
      ...view,
      effective: { ...effective, title: "Checkbox Title" },
      source: { ...source, title: "Checkbox Title" },
      overridden: { ...view.overridden, title: false, publisher: false, series: false },
    };
    renderPanel({ embed_book_metadata: embedded });

    const title = await screen.findByTestId("metadata-title");
    await userEvent.clear(title);
    await userEvent.type(title, "Checkbox Title");
    await userEvent.click(screen.getByTestId("metadata-write-to-file"));
    await userEvent.click(screen.getByTestId("metadata-panel-save"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("embed_book_metadata", {
        bookId: 1,
        form: expect.objectContaining({ title: "Checkbox Title" }),
      }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("update_book_metadata", expect.anything());
  });
});
