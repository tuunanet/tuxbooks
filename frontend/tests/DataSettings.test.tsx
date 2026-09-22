import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DataSettings } from "@/components/settings/DataSettings";
import { SettingsShell } from "@/components/settings/SettingsShell";
import type { StorageReport } from "@/lib/bridge";
import { ThemeStateProvider } from "@/state/ThemeStateProvider";
import { openDataFolderMock, storageReportMock } from "./mocks/bridge";

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
          kind: "derived",
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
      path: "/home/u/Books",
      addedAt: "2026-01-01T00:00:00.000Z",
      bookCount: 12,
      totalBytes: 24 * 1024 * 1024,
    },
  ],
  bookTotalBytes: 24 * 1024 * 1024,
  catalog: { books: 12, authors: 8, collections: 3, annotations: 5, readingProgress: 7 },
};

describe("DataSettings", () => {
  beforeEach(() => {
    storageReportMock.mockReset();
    storageReportMock.mockResolvedValue(REPORT);
    openDataFolderMock.mockReset();
  });

  it("shows the total footprint, both roots, and the reassurance", async () => {
    render(<DataSettings />);

    expect(await screen.findByTestId("storage-total")).toHaveTextContent("6.0 MB");
    expect(screen.getByTestId("storage-root-app-data")).toHaveTextContent("App data");
    expect(screen.getByTestId("storage-root-app-config")).toHaveTextContent(
      "App settings and caches",
    );
    expect(screen.getByTestId("storage-path-app-data")).toHaveTextContent(DATA_PATH);
    expect(screen.getByTestId("storage-path-app-config")).toHaveTextContent(CONFIG_PATH);

    const dataRoot = screen.getByTestId("storage-root-app-data");
    expect(dataRoot).toHaveTextContent("Only copy");
    expect(dataRoot).toHaveTextContent("Derived");
    expect(dataRoot).toHaveTextContent("5.0 MB");
    expect(screen.getByTestId("storage-reassurance")).toHaveTextContent(
      "read in place and never copied",
    );
  });

  it("lists watched locations and catalog counts", async () => {
    render(<DataSettings />);
    await screen.findByTestId("storage-total");

    const locations = screen.getByTestId("storage-book-locations");
    expect(locations).toHaveTextContent("/home/u/Books");
    expect(locations).toHaveTextContent("12 books");
    expect(locations).toHaveTextContent("24.0 MB");

    const catalog = screen.getByTestId("storage-catalog");
    expect(within(catalog).getByTestId("storage-catalog-books")).toHaveTextContent("12");
    expect(within(catalog).getByTestId("storage-catalog-authors")).toHaveTextContent("8");
    expect(within(catalog).getByTestId("storage-catalog-collections")).toHaveTextContent("3");
    expect(within(catalog).getByTestId("storage-catalog-annotations")).toHaveTextContent("5");
    expect(within(catalog).getByTestId("storage-catalog-readingProgress")).toHaveTextContent("7");
  });

  it("shows an empty state when no folders are watched", async () => {
    storageReportMock.mockResolvedValue({ ...REPORT, bookLocations: [], bookTotalBytes: 0 });
    render(<DataSettings />);

    expect(await screen.findByTestId("storage-book-locations-empty")).toHaveTextContent(
      "No folders have been added yet",
    );
  });

  it("opens a root by id and copies its path", async () => {
    const user = userEvent.setup();
    render(<DataSettings />);
    await screen.findByTestId("storage-total");

    const dataRoot = screen.getByTestId("storage-root-app-data");
    await user.click(within(dataRoot).getByRole("button", { name: "Open folder" }));
    expect(openDataFolderMock).toHaveBeenCalledWith("app-data");

    await user.click(within(dataRoot).getByRole("button", { name: "Copy path" }));
    await expect(navigator.clipboard.readText()).resolves.toBe(DATA_PATH);
  });

  it("is reachable from the Settings navigation", async () => {
    const user = userEvent.setup();
    render(
      <ThemeStateProvider>
        <SettingsShell />
      </ThemeStateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Data" }));
    expect(await screen.findByTestId("storage-total")).toBeInTheDocument();
    expect(screen.getByTestId("storage-root-app-config")).toBeInTheDocument();
  });
});
