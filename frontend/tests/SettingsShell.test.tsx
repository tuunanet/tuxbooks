import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
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
    for (const label of ["General", "Reading", "PDF", "Keyboard Shortcuts", "Advanced"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("starts on General with the app theme and library information", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-rows")).toHaveTextContent("Library folder");
    expect(screen.getByTestId("settings-rows")).toHaveTextContent("Managed from the sidebar");
  });

  it("switches sections from the navigation", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    await userEvent.click(screen.getByRole("button", { name: "PDF" }));
    expect(screen.getByRole("heading", { name: "PDF" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-rows")).toHaveTextContent("Default PDF appearance");
    expect(screen.getByTestId("settings-rows")).toHaveTextContent("Continuous, on demand");

    await userEvent.click(screen.getByRole("button", { name: "Reading" }));
    expect(screen.getByRole("heading", { name: "Reading" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-rows")).toHaveTextContent("Default reading appearance");
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

  it("marks every section as informational rather than persisting", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    await userEvent.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByTestId("settings-rows")).toHaveTextContent("Local only");
    expect(screen.getByTestId("settings-rows")).toHaveTextContent("SQLite FTS5");
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
