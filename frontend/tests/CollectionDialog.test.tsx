import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));

import { CollectionDialog, type CreateResult } from "@/components/collections/CollectionDialog";
import { AppStateProvider } from "@/state/AppStateProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { makeCollection } from "./factories";
import { mockInvoke } from "./mocks/tauri";

function withData(children: React.ReactNode) {
  return (
    <AppStateProvider>
      <LibraryDataProvider>
        <ImportProvider>{children}</ImportProvider>
      </LibraryDataProvider>
    </AppStateProvider>
  );
}

function renderDialog(onCreate: (name: string) => Promise<CreateResult>) {
  mockInvoke({
    get_library_stats: { bookCount: 0, collectionCount: 0 },
    list_books: [],
    list_collections: [],
  });
  return render(
    withData(
      <CollectionDialog open onOpenChange={() => undefined} onCreate={onCreate} trigger={false} />,
    ),
  );
}

describe("CollectionDialog", () => {
  it("renders the creation form", async () => {
    renderDialog(vi.fn().mockResolvedValue({ ok: true }));

    const dialog = await screen.findByTestId("collection-dialog");
    expect(dialog).toHaveTextContent("New Collection");
    expect(screen.getByTestId("collection-name")).toBeInTheDocument();
    expect(screen.getByTestId("collection-create")).toBeDisabled();
  });

  it("creates a collection and closes on success", async () => {
    const onCreate = vi
      .fn()
      .mockResolvedValue({ ok: true, collection: makeCollection({ name: "Shelf" }) });
    let open = true;
    const { rerender } = render(
      withData(
        <CollectionDialog
          open
          onOpenChange={(next) => {
            open = next;
          }}
          onCreate={onCreate}
          trigger={false}
        />,
      ),
    );

    await userEvent.type(await screen.findByTestId("collection-name"), "Shelf");
    await userEvent.click(screen.getByTestId("collection-create"));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith("Shelf"));
    expect(open).toBe(false);
    rerender(
      withData(
        <CollectionDialog
          open={false}
          onOpenChange={() => undefined}
          onCreate={onCreate}
          trigger={false}
        />,
      ),
    );
    expect(screen.queryByTestId("collection-dialog")).not.toBeInTheDocument();
  });

  it("surfaces backend rejections inline instead of closing", async () => {
    renderDialog(
      vi.fn().mockResolvedValue({ ok: false, error: "UNIQUE constraint failed: collections.name" }),
    );

    await userEvent.type(await screen.findByTestId("collection-name"), "Favorites");
    await userEvent.click(screen.getByTestId("collection-create"));

    const error = await screen.findByTestId("collection-error");
    expect(error).toHaveTextContent(/unique constraint/i);
    expect(screen.getByTestId("collection-dialog")).toBeInTheDocument();
  });

  it("closes without saving from the close button", async () => {
    let open = true;
    const onCreate = vi.fn().mockResolvedValue({ ok: true });
    const { rerender } = render(
      withData(
        <CollectionDialog
          open
          onOpenChange={(next) => {
            open = next;
          }}
          onCreate={onCreate}
          trigger={false}
        />,
      ),
    );

    await screen.findByTestId("collection-dialog");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(open).toBe(false);
    expect(onCreate).not.toHaveBeenCalled();
    rerender(
      withData(
        <CollectionDialog
          open={false}
          onOpenChange={() => undefined}
          onCreate={onCreate}
          trigger={false}
        />,
      ),
    );
    expect(screen.queryByTestId("collection-dialog")).not.toBeInTheDocument();
  });
});
