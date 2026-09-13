import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { BookMetadataDialog } from "@/components/books/BookMetadataDialog";
import type { BookMetadata, MetadataFields } from "@/types/domain";
import { invokeMock, mockInvoke } from "./mocks/bridge";

const effective = {
  title: "A Minimal Book",
  subtitle: "A Subtitle",
  publisher: "Tuxbooks Press",
  language: "en",
  isbn: null,
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
  authors: ["Ada Lovelace"],
};

const view: BookMetadata = {
  bookId: 1,
  effective,
  source,
  overridden: {
    title: true,
    subtitle: false,
    publisher: false,
    language: false,
    isbn: false,
    description: false,
    publicationDate: false,
    series: false,
    cover: false,
    authors: true,
    subjects: false,
  },
  coverPath: null,
};

const nothingOverridden: BookMetadata["overridden"] = {
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
};

/**
 * The helper registers the load response plus any mutation responses in one
 * `mockInvoke` call, so later registrations never drop earlier ones.
 */
function renderDialog(extraResponses: Record<string, unknown> = {}, metadata: BookMetadata = view) {
  mockInvoke({ get_book_metadata: metadata, ...extraResponses });
  const onOpenChange = vi.fn();
  render(<BookMetadataDialog bookId={1} open onOpenChange={onOpenChange} />);
  return { onOpenChange };
}

describe("BookMetadataDialog", () => {
  it("prefills the form with the effective metadata", async () => {
    renderDialog();

    expect(await screen.findByTestId("metadata-title")).toHaveValue("A Minimal Book");
    expect(screen.getByTestId("metadata-subtitle")).toHaveValue("A Subtitle");
    expect(screen.getByTestId("metadata-authors")).toHaveValue("Ada Lovelace, Charles Babbage");
    expect(screen.getByTestId("metadata-subjects")).toHaveValue("Computing");
    expect(screen.getByTestId("metadata-series")).toHaveValue("Analytical Engines");
    expect(screen.getByTestId("metadata-series-index")).toHaveValue("2");
    expect(screen.getByTestId("metadata-date")).toHaveValue("1843");
    expect(screen.getByTestId("metadata-description")).toHaveValue(
      "A tiny EPUB used as a test fixture.",
    );
  });

  it("marks overridden fields so curation stays visible", async () => {
    renderDialog();

    await screen.findByTestId("metadata-title");
    expect(screen.getByTestId("metadata-title-overridden")).toBeInTheDocument();
    expect(screen.getByTestId("metadata-authors-overridden")).toBeInTheDocument();
    expect(screen.queryByTestId("metadata-subtitle-overridden")).not.toBeInTheDocument();
  });

  it("saves the edited form and closes the dialog", async () => {
    const saved: BookMetadata = { ...view, effective: { ...effective, title: "Curated Title" } };
    const { onOpenChange } = renderDialog({ update_book_metadata: saved });

    await screen.findByTestId("metadata-title");
    const title = screen.getByTestId("metadata-title");
    await userEvent.clear(title);
    await userEvent.type(title, "Curated Title");
    await userEvent.click(screen.getByTestId("metadata-save"));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(invokeMock).toHaveBeenCalledWith("update_book_metadata", {
      bookId: 1,
      form: expect.objectContaining({
        title: "Curated Title",
        authors: ["Ada Lovelace", "Charles Babbage"],
        subjects: ["Computing"],
      }) as MetadataFields,
    });
  });

  it("normalizes the form: empty fields to null, lists split and trimmed", async () => {
    const { onOpenChange } = renderDialog({ update_book_metadata: view });

    await screen.findByTestId("metadata-title");
    await userEvent.clear(screen.getByTestId("metadata-subtitle"));
    await userEvent.clear(screen.getByTestId("metadata-authors"));
    await userEvent.type(screen.getByTestId("metadata-authors"), " Ada Lovelace , Grace Hopper , ");
    await userEvent.click(screen.getByTestId("metadata-save"));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(invokeMock).toHaveBeenCalledWith("update_book_metadata", {
      bookId: 1,
      form: expect.objectContaining({
        subtitle: null,
        authors: ["Ada Lovelace", "Grace Hopper"],
        series: "Analytical Engines",
        seriesIndex: 2,
      }) as MetadataFields,
    });
  });

  it("disables Save while the title is blank and nothing else claims the edit", async () => {
    renderDialog();

    const title = await screen.findByTestId("metadata-title");
    const save = screen.getByTestId("metadata-save");
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.clear(title);
    expect(save).toBeDisabled();
  });

  it("resets to source and repopulates the fields", async () => {
    const reset: BookMetadata = {
      ...view,
      effective: source,
      overridden: nothingOverridden,
    };
    renderDialog({ reset_book_metadata: reset });

    await screen.findByTestId("metadata-title");
    await userEvent.click(screen.getByTestId("metadata-reset"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("reset_book_metadata", { bookId: 1 }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("metadata-title")).toHaveValue("File Garbled Title"),
    );
    expect(screen.getByTestId("metadata-authors")).toHaveValue("Ada Lovelace");
    // After the reset nothing is overridden, so the reset affordance disables.
    await waitFor(() => expect(screen.getByTestId("metadata-reset")).toBeDisabled());
  });

  it("explains the library-vs-file model and the override marker", async () => {
    renderDialog();

    await screen.findByTestId("metadata-title");
    expect(screen.getByTestId("metadata-override-legend")).toHaveTextContent(
      /Unmarked fields match the book file/i,
    );
    expect(screen.getByText(/Save keeps these edits in your library/i)).toBeInTheDocument();
    expect(screen.getByTestId("metadata-embed")).toHaveAttribute(
      "title",
      expect.stringContaining("backup"),
    );
  });

  it("shows the file's value under an overridden field and reverts on demand", async () => {
    renderDialog();

    await screen.findByTestId("metadata-title");
    // Title is overridden in this view; its file value is shown and revertible.
    const titleField = screen.getByTestId("metadata-title").closest("div");
    expect(titleField).not.toBeNull();
    expect(within(titleField!).getByText("File Garbled Title")).toBeInTheDocument();

    await userEvent.click(within(titleField!).getByRole("button", { name: "Use file value" }));
    expect(screen.getByTestId("metadata-title")).toHaveValue("File Garbled Title");

    // A field that matches the file shows no source hint at all.
    const subtitleField = screen.getByTestId("metadata-subtitle").closest("div");
    expect(within(subtitleField!).queryByText(/^File:/)).not.toBeInTheDocument();
  });

  it("shows backend failures instead of pretending to save", async () => {
    renderDialog({
      update_book_metadata: new Error("invalid input: title must not be empty"),
    });

    await screen.findByTestId("metadata-title");
    await userEvent.click(screen.getByTestId("metadata-save"));
    expect(await screen.findByTestId("metadata-error")).toHaveTextContent(
      /title must not be empty/i,
    );
  });

  it("embeds the metadata into the file and reflects the cleared overrides", async () => {
    const embedded: BookMetadata = {
      ...view,
      source: effective,
      overridden: nothingOverridden,
    };
    renderDialog({ embed_book_metadata: embedded });

    await screen.findByTestId("metadata-title");
    expect(screen.getByTestId("metadata-title-overridden")).toBeInTheDocument();
    await userEvent.click(screen.getByTestId("metadata-embed"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("embed_book_metadata", {
        bookId: 1,
        form: expect.objectContaining({ title: "A Minimal Book" }),
      }),
    );
    // The file now carries the effective values, so nothing is overridden and
    // the dialog tells the user Save is unnecessary.
    await waitFor(() =>
      expect(screen.queryByTestId("metadata-title-overridden")).not.toBeInTheDocument(),
    );
    expect(await screen.findByTestId("metadata-embed-success")).toHaveTextContent(
      /no need to Save/i,
    );
  });

  it("keeps unwritable fields as library edits after embed", async () => {
    // A PDF-like outcome: title cleared, but subtitle cannot be stored.
    const embedded: BookMetadata = {
      ...view,
      source: { ...effective, title: "A Minimal Book" },
      overridden: { ...nothingOverridden, subtitle: true },
    };
    renderDialog({ embed_book_metadata: embedded });

    await screen.findByTestId("metadata-title");
    await userEvent.click(screen.getByTestId("metadata-embed"));

    expect(await screen.findByTestId("metadata-embed-success")).toHaveTextContent(
      /can't store stay as library edits/i,
    );
  });

  it("keeps the form and shows an embed failure inline", async () => {
    renderDialog({ embed_book_metadata: new Error("the book file is missing") });

    await screen.findByTestId("metadata-title");
    await userEvent.click(screen.getByTestId("metadata-embed"));

    expect(await screen.findByTestId("metadata-embed-error")).toHaveTextContent(/missing/i);
    expect(screen.getByTestId("metadata-title")).toHaveValue("A Minimal Book");
  });

  it("shows an error state when the curation view fails to load", async () => {
    mockInvoke({ get_book_metadata: new Error("database unavailable") });
    render(<BookMetadataDialog bookId={1} open onOpenChange={() => {}} />);

    expect(await screen.findByTestId("metadata-error")).toHaveTextContent(/database unavailable/i);
  });

  it("hides the cover-restore action unless the cover is overridden", async () => {
    renderDialog();

    await screen.findByTestId("metadata-title");
    expect(screen.queryByTestId("metadata-cover-restore")).not.toBeInTheDocument();

    // With a cover override both the thumbnail and the restore action appear.
    const withCover: BookMetadata = {
      ...view,
      coverPath: "/covers/abc123.png",
      overridden: { ...view.overridden, cover: true },
    };
    mockInvoke({ get_book_metadata: withCover });
    const { unmount } = render(<BookMetadataDialog bookId={2} open onOpenChange={() => {}} />);
    expect(await screen.findByTestId("metadata-cover-thumb")).toHaveAttribute(
      "src",
      "tuxbooks://cover/%2Fcovers%2Fabc123.png",
    );
    expect(screen.getByTestId("metadata-cover-restore")).toBeInTheDocument();
    unmount();
  });
});
