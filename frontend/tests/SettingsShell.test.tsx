import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AppShell } from "@/components/layout/AppShell";
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
              metadataEditorBookId: null,
            }}
          />
        </ImportProvider>
      </LibraryDataProvider>
    </ThemeStateProvider>,
  );
}

describe("SettingsShell", () => {
  beforeEach(() => {
    // The theme provider and its DOM side effects persist across tests in
    // this file's shared jsdom document.
    window.localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
  });

  it("renders the settings view with all sections", async () => {
    renderSettings();

    expect(await screen.findByTestId("settings-view")).toBeInTheDocument();
    for (const label of ["General", "Reading", "PDF", "Keyboard Shortcuts", "Advanced"]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("starts on General with presentational rows", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-rows")).toHaveTextContent("Library folder");
    expect(screen.getByTestId("settings-rows")).toHaveTextContent("Not connected yet");
  });

  it("switches sections from the navigation", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    await userEvent.click(screen.getByRole("button", { name: "PDF" }));
    expect(screen.getByRole("heading", { name: "PDF" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-rows")).toHaveTextContent("Arrives with the PDF engine");

    await userEvent.click(screen.getByRole("button", { name: "Reading" }));
    expect(screen.getByRole("heading", { name: "Reading" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-rows")).toHaveTextContent("100% default (75–400%)");
  });

  it("lists the shortcuts that actually exist today", async () => {
    renderSettings();

    await screen.findByTestId("settings-view");
    await userEvent.click(screen.getByRole("button", { name: "Keyboard Shortcuts" }));

    const rows = screen.getByTestId("settings-rows");
    expect(rows).toHaveTextContent("Ctrl/Cmd + K");
    expect(rows).toHaveTextContent("Ctrl/Cmd + B");
    expect(rows).toHaveTextContent("Home / End");
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
});
