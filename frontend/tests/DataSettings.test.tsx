import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DataSettings } from "@/components/settings/DataSettings";
import { SettingsShell } from "@/components/settings/SettingsShell";
import type { StorageReport, SyncDiagnostics } from "@/lib/bridge";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { ThemeStateProvider } from "@/state/ThemeStateProvider";
import {
  clearCacheMock,
  copyDataPathMock,
  copyLibraryLocationPathMock,
  invokeMock,
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
      missingFromDisk: false,
      status: "idle",
    },
  ],
  bookTotalBytes: 24 * 1024 * 1024,
  catalog: { books: 12, authors: 8, collections: 3, annotations: 5, readingProgress: 7 },
};

/**
 * The Application Data tab reads only the storage report, so it renders on
 * its own with no library provider behind it.
 */
function renderDataSettings() {
  render(<DataSettings />);
}

const DIAGNOSTICS: SyncDiagnostics = {
  generatedAt: "2026-10-31T10:00:00.000Z",
  sync: {
    enabled: true,
    state: "idle",
    folder: "/home/u/Dropbox/TuxBooks",
    lastSyncAt: "2026-10-31T09:59:00.000Z",
    lastError: null,
    counts: {
      pendingLocal: 2,
      waitingBooks: 1,
      issues: 1,
      trash: 0,
      conflicts: 1,
    },
  },
  hashFailed: [
    {
      bookId: 42,
      title: "Example",
      path: "/home/u/Books/example.epub",
      attempts: 2,
      retryAt: "2026-10-31T11:00:00.000Z",
    },
  ],
  openConflicts: [
    {
      id: 7,
      kind: "annotation",
      field: "note",
      bookTitle: "Example",
      createdAt: "2026-10-31T09:00:00.000Z",
    },
  ],
  recentMerges: {
    books: [{ loser: "a".repeat(32), winner: "b".repeat(32) }],
    entities: [{ kind: "collection", loser: "c".repeat(32), winner: "d".repeat(32) }],
  },
  versions: { libraryMarker: 1, opSchema: 1, dbMigration: 28 },
};

const clipboardWrite = vi.fn(async (_text: string) => {});

/**
 * user-event installs its own clipboard stub on `navigator` at setup, so the
 * test's writeText fake has to be re-applied after that.
 */
function setupUser() {
  const user = userEvent.setup();
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWrite },
    configurable: true,
  });
  return user;
}

function routeDiagnostics(payload: SyncDiagnostics = DIAGNOSTICS) {
  invokeMock.mockImplementation((method: string) =>
    method === "sync_diagnostics" ? Promise.resolve(payload) : Promise.reject(new Error(method)),
  );
}

describe("DataSettings", () => {
  beforeEach(() => {
    invokeMock.mockReset();
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
    clipboardWrite.mockReset();
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
    // Identity merges are automatic; the old index card is gone.
    expect(screen.queryByTestId("identity-backfill")).not.toBeInTheDocument();
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

    expect(
      within(catalog).queryByTestId("storage-catalog-outside-watched"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show books" })).not.toBeInTheDocument();
  });

  it("shows an empty state when no folders are watched", async () => {
    storageReportMock.mockResolvedValue({ ...REPORT, bookLocations: [], bookTotalBytes: 0 });
    renderDataSettings();

    expect(await screen.findByTestId("storage-book-locations-empty")).toHaveTextContent(
      "No folders have been added yet",
    );
  });

  it("opens a root by id and copies its path through the bridge", async () => {
    const user = setupUser();
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
    const user = setupUser();
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
    const user = setupUser();
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
      missingFromDisk: false,
      status: "idle" as const,
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
    const user = setupUser();
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
    const user = setupUser();
    renderDataSettings();
    await screen.findByTestId("storage-total");

    await user.click(screen.getByTestId("clear-cache-button"));
    const dialog = await screen.findByTestId("clear-cache-dialog");
    await user.click(within(dialog).getByTestId("clear-cache-cancel"));

    expect(clearCacheMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("clear-cache-dialog")).not.toBeInTheDocument();
  });

  it("clears after confirmation, shows the freed amount, and refreshes the sizes", async () => {
    const user = setupUser();
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

  it("copies diagnostics JSON on click and shows Copied", async () => {
    const user = setupUser();
    routeDiagnostics();
    renderDataSettings();
    await screen.findByTestId("storage-total");

    const card = screen.getByTestId("storage-diagnostics");
    expect(card).toHaveTextContent(
      "sync status, hash failures, conflicts, merges, and schema versions",
    );
    expect(card).toHaveTextContent("never includes book contents or notes");

    await user.click(screen.getByTestId("copy-diagnostics"));

    expect(invokeMock).toHaveBeenCalledWith("sync_diagnostics");
    await waitFor(() =>
      expect(screen.getByTestId("copy-diagnostics-result")).toHaveTextContent("Copied"),
    );
    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    const copied = JSON.parse(String(clipboardWrite.mock.calls[0]?.[0])) as SyncDiagnostics;
    expect(Object.keys(copied)).toEqual(
      expect.arrayContaining([
        "generatedAt",
        "sync",
        "hashFailed",
        "openConflicts",
        "recentMerges",
        "versions",
      ]),
    );
    expect(copied.sync.counts.conflicts).toBe(1);
    expect(copied.hashFailed[0]?.bookId).toBe(42);
    expect(await screen.findByTestId("copy-diagnostics-result")).toHaveTextContent("Copied");
  });

  it("still copies when sync is off, with empty sync lists and versions present", async () => {
    const user = setupUser();
    routeDiagnostics({
      ...DIAGNOSTICS,
      sync: {
        enabled: false,
        state: "disabled",
        folder: null,
        lastSyncAt: null,
        lastError: null,
        counts: {
          pendingLocal: 0,
          waitingBooks: 0,
          issues: 0,
          trash: 0,
          conflicts: 0,
        },
      },
      openConflicts: [],
      recentMerges: { books: [], entities: [] },
      versions: { libraryMarker: null, opSchema: 1, dbMigration: 28 },
    });
    renderDataSettings();
    await screen.findByTestId("storage-total");

    await user.click(screen.getByTestId("copy-diagnostics"));

    await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
    const copied = JSON.parse(String(clipboardWrite.mock.calls[0]?.[0])) as SyncDiagnostics;
    expect(copied.sync.enabled).toBe(false);
    expect(copied.openConflicts).toEqual([]);
    expect(copied.versions.dbMigration).toBe(28);
    expect(await screen.findByTestId("copy-diagnostics-result")).toHaveTextContent("Copied");
  });

  it("shows Copy failed when the diagnostics command rejects", async () => {
    const user = setupUser();
    invokeMock.mockRejectedValue(new Error("sidecar unavailable"));
    renderDataSettings();
    await screen.findByTestId("storage-total");

    await user.click(screen.getByTestId("copy-diagnostics"));

    expect(await screen.findByTestId("copy-diagnostics-result")).toHaveTextContent("Copy failed");
    expect(clipboardWrite).not.toHaveBeenCalled();
    expect(screen.getByTestId("copy-diagnostics")).toBeInTheDocument();
  });

  it("shows Copy failed when the clipboard write rejects", async () => {
    const user = setupUser();
    routeDiagnostics();
    clipboardWrite.mockRejectedValueOnce(new Error("clipboard denied"));
    renderDataSettings();
    await screen.findByTestId("storage-total");

    await user.click(screen.getByTestId("copy-diagnostics"));

    expect(await screen.findByTestId("copy-diagnostics-result")).toHaveTextContent("Copy failed");
  });

  it("clears a stale copy error when a retry starts", async () => {
    const user = setupUser();
    routeDiagnostics();
    invokeMock.mockRejectedValueOnce(new Error("offline"));
    renderDataSettings();
    await screen.findByTestId("storage-total");

    await user.click(screen.getByTestId("copy-diagnostics"));
    expect(await screen.findByTestId("copy-diagnostics-result")).toHaveTextContent("Copy failed");

    let resolve!: (payload: SyncDiagnostics) => void;
    invokeMock.mockImplementation(
      (method: string) =>
        new Promise<SyncDiagnostics>((next) => {
          if (method === "sync_diagnostics") resolve = next;
        }),
    );
    await user.click(screen.getByTestId("copy-diagnostics"));

    await waitFor(() => expect(screen.getByTestId("copy-diagnostics")).toBeDisabled());
    expect(screen.getByTestId("copy-diagnostics-result")).toBeEmptyDOMElement();

    resolve(DIAGNOSTICS);
    expect(await screen.findByTestId("copy-diagnostics-result")).toHaveTextContent("Copied");
  });

  it("disables the diagnostics button while the copy is in flight", async () => {
    const user = setupUser();
    let resolve!: (payload: SyncDiagnostics) => void;
    invokeMock.mockImplementation(
      (method: string) =>
        new Promise<SyncDiagnostics>((next) => {
          if (method === "sync_diagnostics") resolve = next;
        }),
    );
    renderDataSettings();
    await screen.findByTestId("storage-total");

    const button = screen.getByTestId("copy-diagnostics");
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent("Copying...");

    resolve(DIAGNOSTICS);
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(await screen.findByTestId("copy-diagnostics-result")).toHaveTextContent("Copied");
  });

  it("is reachable from the Settings navigation", async () => {
    const user = setupUser();
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
      list_collections: [],
    });
    render(
      <ThemeStateProvider>
        <LibraryDataProvider>
          <ImportProvider>
            <SettingsShell />
          </ImportProvider>
        </LibraryDataProvider>
      </ThemeStateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Application Data" }));
    expect(await screen.findByTestId("storage-total")).toBeInTheDocument();
    expect(screen.getByTestId("storage-root-app-config")).toBeInTheDocument();
  });
});
