import { describe, expect, it, vi } from "vite-plus/test";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  CollectionDialog,
  type CollectionSaveResult,
} from "@/components/collections/CollectionDialog";
import { AppStateProvider } from "@/state/AppStateProvider";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { makeCollection } from "./factories";
import { mockInvoke } from "./mocks/bridge";

function withData(children: React.ReactNode) {
  return (
    <AppStateProvider>
      <LibraryDataProvider>
        <ImportProvider>{children}</ImportProvider>
      </LibraryDataProvider>
    </AppStateProvider>
  );
}

function renderDialog(onSubmit: (name: string) => Promise<CollectionSaveResult>) {
  mockInvoke({
    get_library_stats: { bookCount: 0, collectionCount: 0 },
    list_books: [],
    list_collections: [],
  });
  return render(
    withData(
      <CollectionDialog open onOpenChange={() => undefined} onSubmit={onSubmit} trigger={false} />,
    ),
  );
}

function renderRenameDialog(
  name: string,
  onSubmit: (name: string) => Promise<CollectionSaveResult>,
  onOpenChange: (open: boolean) => void = () => undefined,
) {
  mockInvoke({
    get_library_stats: { bookCount: 0, collectionCount: 1 },
    list_books: [],
    list_collections: [makeCollection({ id: 5, name })],
  });
  return render(
    withData(
      <CollectionDialog
        open
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
        collection={{ id: 5, name }}
        trigger={false}
      />,
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
    const onSubmit = vi
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
          onSubmit={onSubmit}
          trigger={false}
        />,
      ),
    );

    await userEvent.type(await screen.findByTestId("collection-name"), "Shelf");
    await userEvent.click(screen.getByTestId("collection-create"));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Shelf"));
    expect(open).toBe(false);
    rerender(
      withData(
        <CollectionDialog
          open={false}
          onOpenChange={() => undefined}
          onSubmit={onSubmit}
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
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    const { rerender } = render(
      withData(
        <CollectionDialog
          open
          onOpenChange={(next) => {
            open = next;
          }}
          onSubmit={onSubmit}
          trigger={false}
        />,
      ),
    );

    await screen.findByTestId("collection-dialog");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(open).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
    rerender(
      withData(
        <CollectionDialog
          open={false}
          onOpenChange={() => undefined}
          onSubmit={onSubmit}
          trigger={false}
        />,
      ),
    );
    expect(screen.queryByTestId("collection-dialog")).not.toBeInTheDocument();
  });

  it("prefills a rename and submits the new name", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    let open = true;
    renderRenameDialog("Favorites", onSubmit, (next) => {
      open = next;
    });

    expect(await screen.findByTestId("collection-dialog")).toHaveTextContent("Rename Collection");
    const input = screen.getByTestId("collection-name");
    expect(input).toHaveValue("Favorites");
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();

    await userEvent.clear(input);
    await userEvent.type(input, "Keepers{Enter}");

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Keepers"));
    expect(open).toBe(false);
  });

  it("surfaces a duplicate rename inline and stays open", async () => {
    const onSubmit = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "database error: UNIQUE constraint failed" });
    renderRenameDialog("Favorites", onSubmit);

    const input = await screen.findByTestId("collection-name");
    await userEvent.clear(input);
    await userEvent.type(input, "Research{Enter}");

    expect(await screen.findByTestId("collection-error")).toHaveTextContent(/unique constraint/i);
    expect(screen.getByTestId("collection-dialog")).toBeInTheDocument();
  });

  it("cancels a rename with Escape without saving", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    let open = true;
    renderRenameDialog("Favorites", onSubmit, (next) => {
      open = next;
    });

    await screen.findByTestId("collection-dialog");
    await userEvent.keyboard("{Escape}");

    await waitFor(() => expect(open).toBe(false));
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
