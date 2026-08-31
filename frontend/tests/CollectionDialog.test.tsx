import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

import { CollectionDialog } from "@/components/collections/CollectionDialog";
import { AppStateProvider } from "@/state/AppStateProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { mockInvoke } from "./mocks/tauri";

function renderDialog() {
  mockInvoke({
    get_library_stats: { bookCount: 0, collectionCount: 0 },
    list_books: [],
  });
  return render(
    <AppStateProvider>
      <LibraryDataProvider>
        <ImportProvider>
          <CollectionDialog open onOpenChange={() => undefined} trigger={false} />
        </ImportProvider>
      </LibraryDataProvider>
    </AppStateProvider>,
  );
}

describe("CollectionDialog", () => {
  it("shows the creation shell with an honest, disabled create action", async () => {
    renderDialog();

    const dialog = await screen.findByTestId("collection-dialog");
    expect(dialog).toHaveTextContent("New Collection");
    expect(dialog).toHaveTextContent(/not connected to the rust backend yet/i);
    expect(screen.getByTestId("collection-name")).toBeInTheDocument();
    expect(screen.getByTestId("collection-create")).toBeDisabled();
  });

  it("closes without saving from the close button", async () => {
    let open = true;
    const { rerender } = render(
      <AppStateProvider>
        <LibraryDataProvider>
          <ImportProvider>
            <CollectionDialog
              open
              onOpenChange={(next) => {
                open = next;
              }}
              trigger={false}
            />
          </ImportProvider>
        </LibraryDataProvider>
      </AppStateProvider>,
    );

    await screen.findByTestId("collection-dialog");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(open).toBe(false);
    rerender(
      <AppStateProvider>
        <LibraryDataProvider>
          <ImportProvider>
            <CollectionDialog open={false} onOpenChange={() => undefined} trigger={false} />
          </ImportProvider>
        </LibraryDataProvider>
      </AppStateProvider>,
    );
    expect(screen.queryByTestId("collection-dialog")).not.toBeInTheDocument();
  });
});
