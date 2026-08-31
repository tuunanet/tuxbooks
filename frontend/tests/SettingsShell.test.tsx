import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

import { AppShell } from "@/components/layout/AppShell";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { mockInvoke } from "./mocks/tauri";

function renderSettings() {
  mockInvoke({
    get_library_stats: { bookCount: 0, collectionCount: 0 },
    list_books: [],
  });
  return render(
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
    </LibraryDataProvider>,
  );
}

describe("SettingsShell", () => {
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
    expect(screen.getByTestId("settings-rows")).toHaveTextContent("17px default");
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
});
