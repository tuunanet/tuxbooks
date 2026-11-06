import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppShell } from "@/components/layout/AppShell";
import { READER_SETTINGS_STORAGE_KEY } from "@/lib/readerSettings";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { ThemeStateProvider } from "@/state/ThemeStateProvider";
import { mockInvoke } from "./mocks/bridge";

function renderSettings() {
  mockInvoke({
    get_library_stats: { bookCount: 0, collectionCount: 0 },
    list_books: [],
    list_collections: [],
    import_paths: { imported: 0, updated: 0, skipped: 0, failed: [], watched: [], covered: [] },
  });
  return render(
    <ThemeStateProvider>
      <LibraryDataProvider>
        <ImportProvider>
          <AppShell
            initialState={{
              view: "library",
              settingsOpen: true,
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
    for (const label of [
      "General",
      "Viewer settings",
      "Keyboard Shortcuts",
      "Watched folders",
      "Sync",
      "Application Data",
      "About",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("closes the window from the close button", async () => {
    renderSettings();

    await screen.findByTestId("settings-window");
    await userEvent.click(screen.getByRole("button", { name: "Close settings" }));

    await waitFor(() => expect(screen.queryByTestId("settings-window")).not.toBeInTheDocument());
  });

  it("closes the window with Escape", async () => {
    renderSettings();

    await screen.findByTestId("settings-window");
    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByTestId("settings-window")).not.toBeInTheDocument());
  });

  it("keeps the app theme when opened from the library", async () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderSettings();

    const windowEl = await screen.findByTestId("settings-window");
    // No reader token overrides: the document's dark app tokens stay in force.
    expect(document.documentElement).toHaveClass("dark");
    expect(windowEl.style.getPropertyValue("--background")).toBe("");
  });

  it("drags the window by its header", async () => {
    renderSettings();

    const windowEl = await screen.findByTestId("settings-window");
    const handle = windowEl.querySelector<HTMLElement>("[data-settings-drag-handle]");
    expect(handle).not.toBeNull();

    fireEvent.pointerDown(handle!, {
      button: 0,
      pointerId: 1,
      pointerType: "mouse",
      clientX: 200,
      clientY: 100,
    });
    fireEvent.pointerMove(windowEl, {
      pointerId: 1,
      pointerType: "mouse",
      clientX: 260,
      clientY: 130,
    });

    // The offset is applied inside the visibility clamp, which the browser
    // re-evaluates against the viewport on every resize.
    expect(windowEl.style.left).toContain("calc(50% + 60px)");
    expect(windowEl.style.top).toContain("calc(50% + 30px)");
  });

  it("keeps window-level shortcuts from firing behind the window", async () => {
    renderSettings();

    const windowEl = await screen.findByTestId("settings-window");
    const search = screen.getByTestId("global-search");
    fireEvent.keyDown(windowEl, { key: "k", ctrlKey: true });

    expect(search).not.toHaveFocus();
  });

  it("lists About last in the section navigation", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const labels = within(nav)
      .getAllByRole("button")
      .map((button) => button.textContent);
    expect(labels).toEqual([
      "General",
      "Viewer settings",
      "Keyboard Shortcuts",
      "Watched folders",
      "Sync",
      "Application Data",
      "About",
    ]);
  });

  it("starts on General with the app theme and no library actions", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "App theme" })).toBeInTheDocument();

    // Guards against re-adding import UI to General: the Folders tab owns
    // watched folders, and the header menu owns importing.
    const rows = screen.getByTestId("settings-rows");
    expect(rows).toHaveTextContent(`TuxBooks ${__TUXBOOKS_VERSION__}`);
    expect(within(rows).getByRole("link", { name: /View releases/ })).toHaveAttribute(
      "href",
      "https://github.com/tuunanet/tuxbooks/releases",
    );
    expect(within(rows).getByText("Books")).toBeInTheDocument();
    expect(within(rows).getByText("Collections")).toBeInTheDocument();
    expect(rows).not.toHaveTextContent("Add library folder");
    expect(rows).not.toHaveTextContent("Import books");
    expect(rows).not.toHaveTextContent("Importing a file or folder watches its folder");
    expect(rows).not.toHaveTextContent("Library folder");
    expect(rows).not.toHaveTextContent("Header → Import");
    expect(rows).not.toHaveTextContent("Managed from the sidebar");
    expect(rows).not.toHaveTextContent("watched library locations");
  });

  it("switches sections from the navigation", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    await userEvent.click(screen.getByRole("button", { name: "Viewer settings" }));
    expect(screen.getByRole("heading", { name: "Viewer settings" })).toBeInTheDocument();
    const readingRows = screen.getByTestId("settings-rows");
    expect(readingRows).toHaveTextContent("Default reading appearance");
    expect(readingRows).not.toHaveTextContent("How defaults are saved");

    await userEvent.click(screen.getByRole("tab", { name: "PDF" }));
    const pdfRows = screen.getByTestId("settings-rows");
    expect(pdfRows).toHaveTextContent("Default PDF appearance");
    expect(pdfRows).not.toHaveTextContent("Rendering");
    expect(pdfRows).not.toHaveTextContent("Outlines and thumbnails");
  });

  it("opens the Folders section from the navigation", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    await userEvent.click(screen.getByRole("button", { name: "Watched folders" }));
    expect(screen.getByRole("heading", { name: "Watched folders" })).toBeInTheDocument();
    expect(screen.getByTestId("folders-empty")).toBeInTheDocument();
    expect(screen.getByTestId("folders-add")).toBeInTheDocument();
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
    expect(readerSection).toHaveTextContent("Toggle book mode");

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

  it("persists reader appearance defaults from the Viewer settings section", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    await userEvent.click(screen.getByRole("button", { name: "Viewer settings" }));
    expect(screen.getByRole("radio", { name: "Paginated" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "Scrolling" }));
    const stored = JSON.parse(window.localStorage.getItem(READER_SETTINGS_STORAGE_KEY) ?? "{}") as {
      preferences?: { layout?: string };
    };
    expect(stored.preferences?.layout).toBe("scrolling");

    await userEvent.click(screen.getByTestId("reader-settings-reset"));
    expect(window.localStorage.getItem(READER_SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it("offers no book mode control in either defaults editor", async () => {
    // Book mode is a toolbar control only (tuxbooks-9pr.10): the shared
    // appearance controls carry no book mode section for either reader.
    renderSettings();

    await screen.findByTestId("settings-view");
    await userEvent.click(screen.getByRole("button", { name: "Viewer settings" }));
    expect(screen.queryByTestId("pref-book-mode")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "PDF" }));
    expect(screen.queryByTestId("pref-book-mode")).not.toBeInTheDocument();
  });

  it("persists and resets highlight color overrides from the Viewer settings section", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    await userEvent.click(screen.getByRole("button", { name: "Viewer settings" }));
    expect(screen.getByTestId("highlight-settings")).toBeInTheDocument();

    // Pick a custom hue for the light-family yellow slot.
    await userEvent.click(screen.getByTestId("highlight-color-light-yellow"));
    const hexInput = within(await screen.findByTestId("highlight-hex-light-yellow")).getByRole(
      "textbox",
    );
    await userEvent.clear(hexInput);
    await userEvent.type(hexInput, "1e90ff");

    const readOverrides = (): { light?: Record<string, string>; dark?: Record<string, string> } => {
      const stored = JSON.parse(
        window.localStorage.getItem(READER_SETTINGS_STORAGE_KEY) ?? "{}",
      ) as {
        preferences?: {
          highlightOverrides?: { light?: Record<string, string>; dark?: Record<string, string> };
        };
      };
      return stored.preferences?.highlightOverrides ?? {};
    };
    expect(readOverrides().light?.yellow).toBe("#1e90ff");

    // Resetting the family clears its overrides, defaults stay untouched.
    await userEvent.click(screen.getByTestId("highlight-reset-light"));
    expect(readOverrides().light).toEqual({});
  });
});
