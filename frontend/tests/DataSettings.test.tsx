import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DataSettings } from "@/components/settings/DataSettings";
import { SettingsShell } from "@/components/settings/SettingsShell";
import type { StorageReport } from "@/lib/bridge";
import type { Book } from "@/types/domain";
import type { LibrarySection } from "@/state/appState";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { ThemeStateProvider } from "@/state/ThemeStateProvider";
import { makeBook } from "./factories";
import {
  clearCacheMock,
  copyDataPathMock,
  copyLibraryLocationPathMock,
  mockInvoke,
  openDataFolderMock,
  openLibraryLocationMock,
  storageReportMock,
} from "./mocks/bridge";

const DATA_PATH = "/home/u/.local/share/com.tuxbooks.app";
const CONFIG_PATH = "/home/u/.config/TuxBooks";

const REPORT: StorageReport = {
  roots: [
    {
      id: "app-data",
      label: "App data",
      path: DATA_PATH,
      sizeBytes: 5 * 1024 * 1024,
      entries: [
        {
          id: "catalog",
          label: "Catalog database",
          path: `${DATA_PATH}/tuxbooks.db`,
          sizeBytes: 3 * 1024 * 1024,
          kind: "only-copy",
        },
        {
          id: "covers",
          label: "Cover cache",
          path: `${DATA_PATH}/covers`,
          sizeBytes: 2 * 1024 * 1024,
          kind: "only-copy",
        },
      ],
    },
    {
      id: "app-config",
      label: "App settings and caches",
      path: CONFIG_PATH,
      sizeBytes: 1 * 1024 * 1024,
      entries: [
        {
          id: "browser-caches",
          label: "Browser caches",
          path: CONFIG_PATH,
          sizeBytes: 1 * 1024 * 1024,
          kind: "derived",
        },
      ],
    },
  ],
  appDataBytes: 6 * 1024 * 1024,
  cacheBytes: 3 * 1024 * 1024,
  bookLocations: [
    {
      id: 1,
      path: "/home/u/Books",
      addedAt: "2026-01-01T00:00:00.000Z",
      bookCount: 12,
      totalBytes: 24 * 1024 * 1024,
    },
  ],
  bookTotalBytes: 24 * 1024 * 1024,
  catalog: { books: 12, authors: 8, collections: 3, annotations: 5, readingProgress: 7 },
};

/**
 * DataSettings now reads the shared library data for the loose-book count, so
 * every render needs the provider (and its three fetches) plus the section
 * callback the shell supplies.
 */
function renderDataSettings({
  books = [],
  onSelectSection = vi.fn(),
}: { books?: Book[]; onSelectSection?: (section: LibrarySection) => void } = {}) {
  mockInvoke({
    get_library_stats: { bookCount: books.length, collectionCount: 0 },
    list_books: books,
    list_collections: [],
  });
  render(
    <LibraryDataProvider>
      <DataSettings onSelectSection={onSelectSection} />
    </LibraryDataProvider>,
  );
  return { onSelectSection };
}

describe("DataSettings", () => {
  beforeEach(() => {
    storageReportMock.mockReset();
    storageReportMock.mockResolvedValue(REPORT);
    openDataFolderMock.mockReset();
    openLibraryLocationMock.mockReset();
    copyDataPathMock.mockReset();
    copyDataPathMock.mockResolvedValue(undefined);
    copyLibraryLocationPathMock.mockReset();
    copyLibraryLocationPathMock.mockResolvedValue(undefined);
    clearCacheMock.mockReset();
    clearCacheMock.mockResolvedValue(0);
  });

  it("shows the total footprint, both roots, and the reassurance", async () => {
    renderDataSettings();

    expect(await screen.findByTestId("storage-total")).toHaveTextContent("6.0 MB");
    expect(screen.getByTestId("storage-root-app-data")).toHaveTextContent("App data");
    expect(screen.getByTestId("storage-root-app-config")).toHaveTextContent(
      "App settings and caches",
    );
    expect(screen.getByTestId("storage-path-app-data")).toHaveTextContent(DATA_PATH);
    expect(screen.getByTestId("storage-path-app-config")).toHaveTextContent(CONFIG_PATH);

    const dataRoot = screen.getByTestId("storage-root-app-data");
    expect(dataRoot).toHaveTextContent("Only copy");
    expect(dataRoot).toHaveTextContent("5.0 MB");
    expect(screen.getByTestId("storage-root-app-config")).toHaveTextContent("Derived");
    expect(screen.getByTestId("storage-total")).toHaveTextContent("24.0 MB");
    expect(screen.getByTestId("storage-settings-hint")).toHaveTextContent(
      "theme and reader settings",
    );
    expect(screen.getByTestId("storage-reassurance")).toHaveTextContent(
      "read in place and never copied",
    );
  });

  it("lists watched locations and catalog counts", async () => {
    renderDataSettings();
    await screen.findByTestId("storage-total");

    const locations = screen.getByTestId("storage-book-locations");
    expect(locations).toHaveTextContent("Watched folders");
    expect(locations).not.toHaveTextContent("Book folders");
    expect(locations).toHaveTextContent("/home/u/Books");
    expect(locations).toHaveTextContent("12 books");
    expect(locations).toHaveTextContent("24.0 MB");

    const catalog = screen.getByTestId("storage-catalog");
    expect(within(catalog).getByTestId("storage-catalog-books")).toHaveTextContent("12");
    expect(within(catalog).getByTestId("storage-catalog-authors")).toHaveTextContent("8");
    expect(within(catalog).getByTestId("storage-catalog-collections")).toHaveTextContent("3");
    expect(within(catalog).getByTestId("storage-catalog-annotations")).toHaveTextContent("5");
    expect(within(catalog).getByTestId("storage-catalog-readingProgress")).toHaveTextContent("7");

    const loose = within(catalog).getByTestId("storage-catalog-outside-watched");
    expect(loose).toHaveTextContent("Outside watched folders");
    expect(loose).toHaveTextContent("0");
    expect(within(loose).getByRole("button", { name: "Show books" })).toBeDisabled();
  });

  it("counts books outside watched folders and routes to the view", async () => {
    const user = userEvent.setup();
    const { onSelectSection } = renderDataSettings({
      books: [
        makeBook({ id: 1, loose: true }),
        makeBook({ id: 2, loose: true }),
        makeBook({ id: 3, loose: false }),
      ],
    });
    await screen.findByTestId("storage-total");

    const row = screen.getByTestId("storage-catalog-outside-watched");
    expect(row).toHaveTextContent("Outside watched folders");
    expect(row).toHaveTextContent("2");

    await user.click(within(row).getByRole("button", { name: "Show books" }));
    expect(onSelectSection).toHaveBeenCalledWith({ kind: "smart", id: "outside-watched" });
  });

  it("shows an empty state when no folders are watched", async () => {
    storageReportMock.mockResolvedValue({ ...REPORT, bookLocations: [], bookTotalBytes: 0 });
    renderDataSettings();

    expect(await screen.findByTestId("storage-book-locations-empty")).toHaveTextContent(
      "No folders have been added yet",
    );
  });

  it("opens a root by id and copies its path through the bridge", async () => {
    const user = userEvent.setup();
    renderDataSettings();
    await screen.findByTestId("storage-total");

    const dataRoot = screen.getByTestId("storage-root-app-data");
    await user.click(within(dataRoot).getByRole("button", { name: "Open folder" }));
    expect(openDataFolderMock).toHaveBeenCalledWith("app-data");

    const copy = within(dataRoot).getByTestId("copy-root-app-data");
    await user.click(copy);
    expect(copyDataPathMock).toHaveBeenCalledWith("app-data");
    expect(copy).toHaveTextContent("Copied");
  });

  it("copies a watched location by id through the bridge", async () => {
    const user = userEvent.setup();
    renderDataSettings();
    await screen.findByTestId("storage-total");

    const location = screen.getByTestId("storage-location-1");
    await user.click(within(location).getByRole("button", { name: "Open folder" }));
    expect(openLibraryLocationMock).toHaveBeenCalledWith(1);

    const copy = within(location).getByTestId("copy-location-1");
    await user.click(copy);
    expect(copyLibraryLocationPathMock).toHaveBeenCalledWith(1);
    expect(copy).toHaveTextContent("Copied");
  });

  it("shows an error state when a path copy rejects", async () => {
    const user = userEvent.setup();
    copyDataPathMock.mockRejectedValue(new Error("denied"));
    renderDataSettings();
    await screen.findByTestId("storage-total");

    const copy = screen.getByTestId("copy-root-app-data");
    await user.click(copy);
    expect(await screen.findByText("Copy failed")).toBeInTheDocument();
  });

  it("keeps a long folder list scrollable and shows the count", async () => {
    const many = Array.from({ length: 250 }, (_, index) => ({
      id: index + 1,
      path: `/home/u/Books/${index}`,
      addedAt: "2026-01-01T00:00:00.000Z",
      bookCount: 1,
      totalBytes: 1024,
    }));
    storageReportMock.mockResolvedValue({
      ...REPORT,
      bookLocations: many,
      bookTotalBytes: 250 * 1024,
    });
    renderDataSettings();
    await screen.findByTestId("storage-total");

    expect(screen.getByTestId("storage-book-locations")).toHaveTextContent("Watched folders (250)");
    const list = screen.getByTestId("storage-book-location-list");
    expect(list).toHaveClass("overflow-y-auto");
    expect(within(list).getAllByRole("listitem")).toHaveLength(250);
  });

  it("shows the cache total on the clear button and confirms what goes and stays", async () => {
    const user = userEvent.setup();
    renderDataSettings();
    await screen.findByTestId("storage-total");

    const button = screen.getByTestId("clear-cache-button");
    expect(button).toHaveTextContent("3.0 MB");

    await user.click(button);
    const dialog = await screen.findByTestId("clear-cache-dialog");
    expect(dialog).toHaveTextContent("browser caches");
    expect(dialog).toHaveTextContent("GPU fallback marker");
    expect(dialog).toHaveTextContent("catalog");
    expect(dialog).toHaveTextContent("cover cache");
    expect(dialog).toHaveTextContent("settings");
    expect(clearCacheMock).not.toHaveBeenCalled();
  });

  it("cancel closes the confirmation without clearing", async () => {
    const user = userEvent.setup();
    renderDataSettings();
    await screen.findByTestId("storage-total");

    await user.click(screen.getByTestId("clear-cache-button"));
    const dialog = await screen.findByTestId("clear-cache-dialog");
    await user.click(within(dialog).getByTestId("clear-cache-cancel"));

    expect(clearCacheMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("clear-cache-dialog")).not.toBeInTheDocument();
  });

  it("clears after confirmation, shows the freed amount, and refreshes the sizes", async () => {
    const user = userEvent.setup();
    const after: StorageReport = { ...REPORT, cacheBytes: 0, appDataBytes: 3 * 1024 * 1024 };
    storageReportMock.mockResolvedValueOnce(REPORT);
    storageReportMock.mockResolvedValueOnce(after);
    clearCacheMock.mockResolvedValue(3 * 1024 * 1024);
    renderDataSettings();
    await screen.findByTestId("storage-total");

    await user.click(screen.getByTestId("clear-cache-button"));
    const dialog = await screen.findByTestId("clear-cache-dialog");
    await user.click(within(dialog).getByTestId("clear-cache-confirm"));

    expect(clearCacheMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId("storage-clear-result")).toHaveTextContent("Freed 3.0 MB");
    expect(storageReportMock).toHaveBeenCalledTimes(2);
    expect(await screen.findByTestId("storage-total")).toHaveTextContent("3.0 MB");
    expect(screen.getByTestId("clear-cache-button")).toHaveTextContent("0.0 MB");
  });

  it("shows the cover cache but never offers to clear it", async () => {
    renderDataSettings();
    await screen.findByTestId("storage-total");

    const dataRoot = screen.getByTestId("storage-root-app-data");
    const covers = within(dataRoot).getByText("Cover cache").closest("li");
    expect(covers).not.toBeNull();
    expect(within(covers as HTMLElement).queryByRole("button")).toBeNull();
    expect(screen.getAllByTestId("clear-cache-button")).toHaveLength(1);
  });

  it("is reachable from the Settings navigation", async () => {
    const user = userEvent.setup();
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
      list_collections: [],
    });
    render(
      <ThemeStateProvider>
        <LibraryDataProvider>
          <ImportProvider>
            <SettingsShell onSelectSection={vi.fn()} />
          </ImportProvider>
        </LibraryDataProvider>
      </ThemeStateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Data" }));
    expect(await screen.findByTestId("storage-total")).toBeInTheDocument();
    expect(screen.getByTestId("storage-root-app-config")).toBeInTheDocument();
  });
});
