import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FoldersSettings } from "@/components/settings/FoldersSettings";
import type { StorageReport } from "@/lib/bridge";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { mockInvoke, pickDirectoryMock, storageReportMock, invokeMock } from "./mocks/bridge";

const REPORT: StorageReport = {
  roots: [],
  appDataBytes: 0,
  cacheBytes: 0,
  bookLocations: [
    {
      id: 1,
      path: "/home/u/Books",
      addedAt: "2026-01-01T00:00:00.000Z",
      bookCount: 12,
      totalBytes: 24 * 1024 * 1024,
      missingFromDisk: false,
    },
    {
      id: 2,
      path: "/mnt/gone/Docs",
      addedAt: "2026-01-02T00:00:00.000Z",
      bookCount: 3,
      totalBytes: 1024 * 1024,
      missingFromDisk: true,
    },
  ],
  bookTotalBytes: 25 * 1024 * 1024,
  catalog: { books: 15, authors: 8, collections: 3, annotations: 5, readingProgress: 7 },
};

function renderFolders(extra: Record<string, unknown> = {}) {
  mockInvoke({
    get_library_stats: { bookCount: 15, collectionCount: 0 },
    list_books: [],
    list_collections: [],
    import_paths: { imported: 1, updated: 0, skipped: 0, failed: [] },
    unwatch_locations: 1,
    ...extra,
  });
  return render(
    <LibraryDataProvider>
      <ImportProvider>
        <FoldersSettings />
      </ImportProvider>
    </LibraryDataProvider>,
  );
}

describe("FoldersSettings", () => {
  beforeEach(() => {
    storageReportMock.mockReset();
    storageReportMock.mockResolvedValue(REPORT);
    pickDirectoryMock.mockReset();
    pickDirectoryMock.mockResolvedValue(null);
    invokeMock.mockReset();
  });

  it("lists every watched folder with its book count and total size", async () => {
    renderFolders();

    const list = await screen.findByTestId("folders-list");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    const present = screen.getByTestId("folder-row-1");
    expect(present).toHaveTextContent("/home/u/Books");
    expect(present).toHaveTextContent("12 books · 24.0 MB");

    const gone = screen.getByTestId("folder-row-2");
    expect(gone).toHaveTextContent("/mnt/gone/Docs");
    expect(gone).toHaveTextContent("3 books · 1.0 MB");
  });

  it("labels a watched folder whose path is gone from disk", async () => {
    renderFolders();

    await screen.findByTestId("folders-list");
    expect(screen.getByTestId("folder-missing-2")).toHaveTextContent("Missing from disk");
    expect(screen.getByTestId("folder-row-1")).not.toHaveTextContent("Missing from disk");
  });

  it("shows an empty list as an invitation to add a folder", async () => {
    storageReportMock.mockResolvedValue({ ...REPORT, bookLocations: [] });
    renderFolders();

    expect(await screen.findByTestId("folders-empty")).toHaveTextContent(
      "No folders have been added yet",
    );
    expect(screen.getByTestId("folders-add")).toBeEnabled();
  });

  it("disables Add folder while a pick-and-import run is in flight", async () => {
    let resolvePick!: (value: string | null) => void;
    pickDirectoryMock.mockReturnValue(
      new Promise<string | null>((resolve) => {
        resolvePick = resolve;
      }),
    );
    renderFolders();

    const add = await screen.findByTestId("folders-add");
    expect(add).toBeEnabled();

    await userEvent.click(add);
    expect(add).toBeDisabled();

    resolvePick("/picked/folder");
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("import_paths", { paths: ["/picked/folder"] }),
    );
    await waitFor(() => expect(screen.getByTestId("folders-add")).toBeEnabled());
  });

  it("keeps the list in step with the import by re-reading the report", async () => {
    pickDirectoryMock.mockResolvedValue("/picked/folder");
    renderFolders();
    await screen.findByTestId("folders-list");

    await userEvent.click(screen.getByTestId("folders-add"));

    await waitFor(() => expect(storageReportMock).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("folders-add")).toBeEnabled();
  });

  it("imports nothing when the picker is cancelled", async () => {
    pickDirectoryMock.mockResolvedValue(null);
    renderFolders();

    const add = await screen.findByTestId("folders-add");
    await userEvent.click(add);

    await waitFor(() => expect(pickDirectoryMock).toHaveBeenCalledTimes(1));
    expect(invokeMock).not.toHaveBeenCalledWith("import_paths", expect.anything());
    expect(add).toBeEnabled();
  });
});

/** A list of `count` watched folders, two books each, nothing missing. */
function manyFolders(count: number): StorageReport {
  const bookLocations = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    path: `/books/shelf-${index + 1}`,
    addedAt: "2026-01-01T00:00:00.000Z",
    bookCount: 2,
    totalBytes: 1024 * 1024,
    missingFromDisk: false,
  }));
  return { ...REPORT, bookLocations };
}

describe("FoldersSettings unwatch", () => {
  beforeEach(() => {
    storageReportMock.mockReset();
    storageReportMock.mockResolvedValue(REPORT);
    pickDirectoryMock.mockReset();
    pickDirectoryMock.mockResolvedValue(null);
    invokeMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps Unwatch disabled until a folder is selected", async () => {
    renderFolders();

    const unwatch = await screen.findByTestId("folders-unwatch");
    expect(unwatch).toBeDisabled();

    await userEvent.click(screen.getByTestId("folder-select-1"));
    expect(unwatch).toBeEnabled();

    await userEvent.click(screen.getByTestId("folder-select-1"));
    expect(unwatch).toBeDisabled();
  });

  it("selects every row from the header and clears the choice with Cancel", async () => {
    renderFolders();
    await screen.findByTestId("folders-list");

    await userEvent.click(screen.getByTestId("folders-select-all"));
    expect(screen.getByTestId("folder-select-1")).toBeChecked();
    expect(screen.getByTestId("folder-select-2")).toBeChecked();
    expect(screen.getByTestId("folders-unwatch")).toBeEnabled();

    await userEvent.click(screen.getByTestId("folders-clear"));
    expect(screen.getByTestId("folder-select-1")).not.toBeChecked();
    expect(screen.getByTestId("folder-select-2")).not.toBeChecked();
    expect(screen.getByTestId("folders-unwatch")).toBeDisabled();
    expect(screen.queryByTestId("folders-clear")).toBeNull();
  });

  it("names the one folder and its book count in the dialog", async () => {
    renderFolders();
    await screen.findByTestId("folders-list");

    await userEvent.click(screen.getByTestId("folder-select-1"));
    await userEvent.click(screen.getByTestId("folders-unwatch"));

    const dialog = await screen.findByTestId("unwatch-dialog");
    expect(dialog).toHaveTextContent("Unwatch /home/u/Books?");
    expect(dialog).toHaveTextContent("12 books stay in your library under “Loose Books”");
    expect(dialog).toHaveTextContent("Your files on disk stay untouched.");
    expect(within(dialog).queryByTestId("unwatch-names")).toBeNull();
  });

  it("aggregates several folders and overflows the name list", async () => {
    storageReportMock.mockResolvedValue(manyFolders(5));
    renderFolders();
    await screen.findByTestId("folders-list");

    await userEvent.click(screen.getByTestId("folders-select-all"));
    await userEvent.click(screen.getByTestId("folders-unwatch"));

    const dialog = await screen.findByTestId("unwatch-dialog");
    expect(dialog).toHaveTextContent("Unwatch 5 folders?");
    expect(dialog).toHaveTextContent("10 books stay in your library under “Loose Books”");

    const names = within(dialog).getByTestId("unwatch-names");
    expect(within(names).getAllByRole("listitem")).toHaveLength(3);
    expect(dialog).toHaveTextContent("+2 more");
    expect(dialog).toHaveTextContent("Unwatch 5 Folders");
  });

  it("unwatches the selection and re-reads the folder list", async () => {
    renderFolders();
    await screen.findByTestId("folders-list");

    await userEvent.click(screen.getByTestId("folder-select-1"));
    await userEvent.click(screen.getByTestId("folders-unwatch"));
    await screen.findByTestId("unwatch-dialog");

    storageReportMock.mockResolvedValue({
      ...REPORT,
      bookLocations: REPORT.bookLocations.slice(1),
    });
    await userEvent.click(screen.getByTestId("unwatch-confirm"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("unwatch_locations", expect.anything()),
    );
    await waitFor(() => {
      const rows = within(screen.getByTestId("folders-list")).getAllByRole("listitem");
      expect(rows).toHaveLength(1);
    });
    expect(screen.queryByTestId("unwatch-dialog")).toBeNull();
    expect(screen.getByTestId("folders-unwatch")).toBeDisabled();
  });

  it("closes the dialog without unwatching anything", async () => {
    renderFolders();
    await screen.findByTestId("folders-list");

    await userEvent.click(screen.getByTestId("folder-select-2"));
    await userEvent.click(screen.getByTestId("folders-unwatch"));
    await screen.findByTestId("unwatch-dialog");

    await userEvent.click(screen.getByTestId("unwatch-cancel"));
    await waitFor(() => expect(screen.queryByTestId("unwatch-dialog")).toBeNull());
    expect(invokeMock).not.toHaveBeenCalledWith("unwatch_locations", expect.anything());
    expect(screen.getByTestId("folders-unwatch")).toBeEnabled();
  });

  it("keeps the dialog open when the sidecar refuses the unwatch", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    renderFolders({ unwatch_locations: new Error("database is locked") });
    await screen.findByTestId("folders-list");

    await userEvent.click(screen.getByTestId("folder-select-1"));
    await userEvent.click(screen.getByTestId("folders-unwatch"));
    const dialog = await screen.findByTestId("unwatch-dialog");

    await userEvent.click(screen.getByTestId("unwatch-confirm"));
    await waitFor(() => expect(logged).toHaveBeenCalled());
    logged.mockRestore();

    // Nothing happened, so nothing may look like it did: the folder is still
    // selected, the choice is still on screen, and the list was not re-read.
    expect(screen.getByTestId("unwatch-dialog")).toBe(dialog);
    expect(screen.getByTestId("folder-select-1")).toBeChecked();
    expect(screen.getByTestId("folders-unwatch")).toBeEnabled();
    expect(storageReportMock).toHaveBeenCalledTimes(1);
  });
  it("offers the remove-from-library box, off by default", async () => {
    renderFolders();
    await screen.findByTestId("folders-list");

    await userEvent.click(screen.getByTestId("folder-select-1"));
    await userEvent.click(screen.getByTestId("folders-unwatch"));

    const dialog = await screen.findByTestId("unwatch-dialog");
    const box = within(dialog).getByTestId("unwatch-remove-books");
    expect(box).not.toBeChecked();
    // The default promise still stands until the box is ticked.
    expect(dialog).toHaveTextContent("12 books stay in your library under “Loose Books”");
    expect(box).toHaveAccessibleName("Also remove these 12 books from the library");
  });

  it("sends removeBooks false when the box is left alone", async () => {
    renderFolders();
    await screen.findByTestId("folders-list");

    await userEvent.click(screen.getByTestId("folder-select-1"));
    await userEvent.click(screen.getByTestId("folders-unwatch"));
    await screen.findByTestId("unwatch-dialog");

    await userEvent.click(screen.getByTestId("unwatch-confirm"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("unwatch_locations", {
        paths: ["/home/u/Books"],
        removeBooks: false,
      }),
    );
  });

  it("sends removeBooks true when the box is ticked", async () => {
    renderFolders();
    await screen.findByTestId("folders-list");

    await userEvent.click(screen.getByTestId("folder-select-1"));
    await userEvent.click(screen.getByTestId("folders-unwatch"));
    const dialog = await screen.findByTestId("unwatch-dialog");

    await userEvent.click(within(dialog).getByTestId("unwatch-remove-books"));
    expect(within(dialog).getByTestId("unwatch-remove-books")).toBeChecked();
    // The keep promise must not survive the tick.
    expect(dialog).toHaveTextContent("The 12 books in this folder are removed from your library.");

    await userEvent.click(screen.getByTestId("unwatch-confirm"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("unwatch_locations", {
        paths: ["/home/u/Books"],
        removeBooks: true,
      }),
    );
  });

  it("still offers the box for a folder with no books", async () => {
    storageReportMock.mockResolvedValue({
      ...REPORT,
      bookLocations: [
        {
          id: 1,
          path: "/home/u/Empty",
          addedAt: "2026-01-01T00:00:00.000Z",
          bookCount: 0,
          totalBytes: 0,
          missingFromDisk: false,
        },
      ],
    });
    renderFolders();
    await screen.findByTestId("folders-list");

    await userEvent.click(screen.getByTestId("folder-select-1"));
    await userEvent.click(screen.getByTestId("folders-unwatch"));

    const dialog = await screen.findByTestId("unwatch-dialog");
    expect(dialog).toHaveTextContent("Unwatch /home/u/Empty?");
    expect(dialog).toHaveTextContent("No books live in this folder.");
    const box = within(dialog).getByTestId("unwatch-remove-books");
    expect(box).not.toBeChecked();
    expect(box).toBeDisabled();
    expect(box).toHaveAccessibleName("Also remove these 0 books from the library");
  });

  it("reopens with the box off after a cancelled confirmation", async () => {
    renderFolders();
    await screen.findByTestId("folders-list");

    await userEvent.click(screen.getByTestId("folder-select-1"));
    await userEvent.click(screen.getByTestId("folders-unwatch"));
    const first = await screen.findByTestId("unwatch-dialog");
    await userEvent.click(within(first).getByTestId("unwatch-remove-books"));
    expect(within(first).getByTestId("unwatch-remove-books")).toBeChecked();

    await userEvent.click(screen.getByTestId("unwatch-cancel"));
    await waitFor(() => expect(screen.queryByTestId("unwatch-dialog")).toBeNull());

    await userEvent.click(screen.getByTestId("folders-unwatch"));
    const second = await screen.findByTestId("unwatch-dialog");
    expect(within(second).getByTestId("unwatch-remove-books")).not.toBeChecked();
    expect(invokeMock).not.toHaveBeenCalledWith("unwatch_locations", expect.anything());
  });
});
