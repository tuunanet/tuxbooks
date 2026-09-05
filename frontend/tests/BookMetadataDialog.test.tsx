import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

import { BookMetadataDialog } from "@/components/books/BookMetadataDialog";
import type { BookMetadata, MetadataFields } from "@/types/domain";
import { invokeMock, mockInvoke } from "./mocks/tauri";

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
      "asset://localhost/%2Fcovers%2Fabc123.png",
    );
    expect(screen.getByTestId("metadata-cover-restore")).toBeInTheDocument();
    unmount();
  });
});
