import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { Sidebar } from "@/components/layout/Sidebar";
import { AppStateProvider } from "@/state/AppStateProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { initialAppState, type LibrarySection } from "@/state/appState";
import { mockInvoke } from "./mocks/tauri";

function renderSidebar(onSectionChange: (section: LibrarySection) => void) {
  mockInvoke({
    get_library_stats: { bookCount: 0, collectionCount: 0 },
    list_books: [],
  });
  return render(
    <AppStateProvider>
      <LibraryDataProvider>
        <Sidebar active={initialAppState.section} onSectionChange={onSectionChange} />
      </LibraryDataProvider>
    </AppStateProvider>,
  );
}

describe("Sidebar", () => {
  it("renders the navigation groups and items", () => {
    renderSidebar(vi.fn());

    expect(screen.getByTestId("sidebar")).toBeInTheDocument();
    expect(screen.getByText("Library")).toBeInTheDocument();
    expect(screen.getByText("Collections")).toBeInTheDocument();
    for (const label of [
      "All Books",
      "EPUBs",
      "PDFs",
      "Recently Added",
      "Recently Read",
      "In Progress",
      "Finished",
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("marks the active section and updates on click", async () => {
    const onSectionChange = vi.fn();
    renderSidebar(onSectionChange);

    const allBooks = screen.getByRole("button", { name: "All Books" });
    expect(allBooks).toHaveAttribute("aria-current");

    await userEvent.click(screen.getByRole("button", { name: "Recently Added" }));
    expect(onSectionChange).toHaveBeenCalledWith({ kind: "smart", id: "recently-added" });
  });

  it("navigates to settings", async () => {
    const onSectionChange = vi.fn();
    renderSidebar(onSectionChange);

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onSectionChange).toHaveBeenCalledWith({ kind: "settings" });
  });

  it("shows the new-collection action as an honest disabled placeholder", () => {
    renderSidebar(vi.fn());

    const button = screen.getByRole("button", { name: "+ New Collection" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(/rust backend/i);
  });
});
