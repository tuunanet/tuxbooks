import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppShell } from "@/components/layout/AppShell";
import { READER_SETTINGS_STORAGE_KEY } from "@/lib/readerSettings";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { ThemeStateProvider } from "@/state/ThemeStateProvider";
import { mockInvoke, pickBookFilesMock, pickDirectoryMock, invokeMock } from "./mocks/bridge";

function renderSettings() {
  mockInvoke({
    get_library_stats: { bookCount: 0, collectionCount: 0 },
    list_books: [],
    list_collections: [],
    import_paths: { imported: 0, updated: 0, skipped: 0, failed: [] },
  });
  return render(
    <ThemeStateProvider>
      <LibraryDataProvider>
        <ImportProvider>
          <AppShell
            initialState={{
              view: "library",
              section: { kind: "settings" },
              selectedBookId: null,
              libraryQuery: "",
            }}
          />
        </ImportProvider>
      </LibraryDataProvider>
    </ThemeStateProvider>,
  );
}

const originalPlatform = Object.getOwnPropertyDescriptor(navigator, "platform");

describe("SettingsShell", () => {
  beforeEach(() => {
    // The theme provider and its DOM side effects persist across tests in
    // this file's shared jsdom document.
    window.localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(navigator, "platform", originalPlatform);
    else Reflect.deleteProperty(navigator, "platform");
  });

  it("renders the settings view with all sections", async () => {
    renderSettings();

    expect(await screen.findByTestId("settings-view")).toBeInTheDocument();
    for (const label of ["General", "Reading", "PDF", "Keyboard Shortcuts", "Data", "About"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("lists About last in the section navigation", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const labels = within(nav)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(labels).toEqual(["General", "Reading", "PDF", "Keyboard Shortcuts", "Data", "About"]);
  });

  it("starts on General with the app theme and library import actions", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "App theme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add library folder…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import books…" })).toBeInTheDocument();

    const rows = screen.getByTestId("settings-rows");
    expect(rows).not.toHaveTextContent("Library folder");
    expect(rows).not.toHaveTextContent("Header → Import");
    expect(rows).not.toHaveTextContent("Managed from the sidebar");
    expect(rows).toHaveTextContent("Single files import in place and are not watched");
    expect(rows).toHaveTextContent("Folders you add become watched folders");
    expect(rows).not.toHaveTextContent("watched library locations");
  });

  it("switches sections from the navigation", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    await userEvent.click(screen.getByRole("button", { name: "PDF" }));
    expect(screen.getByRole("heading", { name: "PDF" })).toBeInTheDocument();
    const pdfRows = screen.getByTestId("settings-rows");
    expect(pdfRows).toHaveTextContent("Default PDF appearance");
    expect(pdfRows).not.toHaveTextContent("Rendering");
    expect(pdfRows).not.toHaveTextContent("Outlines and thumbnails");

    await userEvent.click(screen.getByRole("button", { name: "Reading" }));
    expect(screen.getByRole("heading", { name: "Reading" })).toBeInTheDocument();
    const readingRows = screen.getByTestId("settings-rows");
    expect(readingRows).toHaveTextContent("Default reading appearance");
    expect(readingRows).not.toHaveTextContent("How defaults are saved");
  });

  it("lists the full shortcut reference grouped by scope", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    await userEvent.click(screen.getByRole("button", { name: "Keyboard Shortcuts" }));

    const rows = screen.getByTestId("settings-rows");
    for (const label of ["Global", "Library", "Reader", "PDF reader"]) {
      expect(within(rows).getByRole("heading", { name: label })).toBeInTheDocument();
    }

    expect(rows).toHaveTextContent("Focus search");
    expect(rows).toHaveTextContent("Ctrl+K");
    expect(rows).toHaveTextContent("Open selected book");
    expect(rows).toHaveTextContent("Next page or section");
    expect(rows).toHaveTextContent("Previous page or section");
    expect(rows).toHaveTextContent("Presentation mode");
    expect(rows).toHaveTextContent("Toggle appearance");
    expect(rows).toHaveTextContent("Ctrl+Shift+A");
    expect(rows).toHaveTextContent("Toggle contents drawer");
    expect(rows).toHaveTextContent("Open bookmarks");
    expect(rows).toHaveTextContent("Open highlights");
    expect(rows).toHaveTextContent("Zoom in");
    expect(rows).toHaveTextContent("Reset zoom");
    expect(rows).toHaveTextContent("Fit width");
    expect(rows).toHaveTextContent("Reverse page flip in presentation");

    const readerSection = within(rows)
      .getByRole("heading", { name: "Reader" })
      .closest("section") as HTMLElement;
    expect(readerSection).toHaveTextContent("Toggle appearance");

    const pdfSection = within(rows)
      .getByRole("heading", { name: "PDF reader" })
      .closest("section") as HTMLElement;
    expect(pdfSection).toHaveTextContent("Reverse page flip in presentation");
    expect(pdfSection).not.toHaveTextContent("Toggle appearance");
  });

  it("renders shortcut modifiers as Cmd on macOS", async () => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    renderSettings();

    await screen.findByTestId("settings-view");
    await userEvent.click(screen.getByRole("button", { name: "Keyboard Shortcuts" }));

    const rows = screen.getByTestId("settings-rows");
    expect(rows).toHaveTextContent("Cmd+K");
    expect(rows).toHaveTextContent("Cmd+Shift+A");
    expect(rows).not.toHaveTextContent("Ctrl+K");
  });

  it("imports the picked folder from General", async () => {
    pickDirectoryMock.mockResolvedValue("/picked/library");
    renderSettings();

    await screen.findByTestId("settings-view");
    await userEvent.click(screen.getByRole("button", { name: "Add library folder…" }));

    expect(pickDirectoryMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("import_paths", { paths: ["/picked/library"] });
  });

  it("imports picked files from General", async () => {
    pickBookFilesMock.mockResolvedValue(["/a/one.epub", "/b/two.pdf"]);
    renderSettings();

    await screen.findByTestId("settings-view");
    await userEvent.click(screen.getByRole("button", { name: "Import books…" }));

    expect(pickBookFilesMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("import_paths", {
      paths: ["/a/one.epub", "/b/two.pdf"],
    });
  });

  it("applies and persists the app theme from the General section", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    expect(screen.getByRole("radiogroup", { name: "App theme" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-rows")).toHaveTextContent("Following system");

    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(screen.getByTestId("settings-rows")).toHaveTextContent("Always dark");

    await userEvent.click(screen.getByRole("radio", { name: "System" }));
    expect(document.documentElement).not.toHaveClass("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("persists reader appearance defaults from the Reading section", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    await userEvent.click(screen.getByRole("button", { name: "Reading" }));
    expect(screen.getByRole("radio", { name: "Paginated" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "Scrolling" }));
    const stored = JSON.parse(window.localStorage.getItem(READER_SETTINGS_STORAGE_KEY) ?? "{}") as {
      preferences?: { layout?: string };
    };
    expect(stored.preferences?.layout).toBe("scrolling");

    await userEvent.click(screen.getByTestId("reader-settings-reset"));
    expect(window.localStorage.getItem(READER_SETTINGS_STORAGE_KEY)).toBeNull();
  });
});
