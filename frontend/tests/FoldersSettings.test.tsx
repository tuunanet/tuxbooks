import { beforeEach, describe, expect, it } from "vitest";
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

function renderFolders() {
  mockInvoke({
    get_library_stats: { bookCount: 15, collectionCount: 0 },
    list_books: [],
    list_collections: [],
    import_paths: { imported: 1, updated: 0, skipped: 0, failed: [] },
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
