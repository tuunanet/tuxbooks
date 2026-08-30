import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

import { EmptyLibraryState } from "@/components/library/EmptyLibraryState";
import { AppStateProvider } from "@/state/AppStateProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { mockInvoke } from "./mocks/tauri";

describe("EmptyLibraryState", () => {
  it("explains how to add books and offers the folder picker", () => {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
    });
    render(
      <AppStateProvider>
        <LibraryDataProvider>
          <ImportProvider>
            <EmptyLibraryState />
          </ImportProvider>
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    expect(screen.getByText("Your library is empty")).toBeInTheDocument();
    expect(screen.getByText(/Point tuxbooks at a folder of EPUB files/i)).toBeInTheDocument();
    expect(screen.getByTestId("empty-library-import")).toHaveTextContent("Import Folder…");
  });
});
