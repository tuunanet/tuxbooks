import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import userEvent from "@testing-library/user-event";

import { AppShell } from "@/components/layout/AppShell";
import { makeBook } from "./factories";
import {
  invokeMock,
  mockInvoke,
  pathForFileMock,
  pickDirectoryMock,
  pickBookFilesMock,
} from "./mocks/bridge";

function renderShellWithLibrary(
  books: ReturnType<typeof makeBook>[] = [],
  importReport: unknown = { imported: 0, updated: 0, failed: [] },
) {
  mockInvoke({
    get_library_stats: { bookCount: books.length, collectionCount: 0 },
    list_books: books,
    list_collections: [],
    import_paths: importReport,
  });
  return render(<AppShell />);
}

/** jsdom has no DragEvent; a plain Event carrying dataTransfer is what the
 * DropZoneOverlay handlers read. */
function makeDragEvent(type: string, files: File[]): Event {
  const dataTransfer = {
    types: ["Files"],
    files,
  } as unknown as DataTransfer;
  const DragEventCtor =
    window.DragEvent ??
    (class extends Event {
      dataTransfer: DataTransfer | null;
      constructor(type: string, init: DragEventInit = {}) {
        super(type, init);
        this.dataTransfer = init.dataTransfer ?? null;
      }
    } as unknown as typeof DragEvent);
  return new DragEventCtor(type, { dataTransfer });
}

async function dragEnter(files: File[]): Promise<void> {
  await act(async () => {
    window.dispatchEvent(makeDragEvent("dragenter", files));
  });
}

async function dragDrop(files: File[]): Promise<void> {
  await act(async () => {
    window.dispatchEvent(makeDragEvent("drop", files));
  });
}

describe("Import via the header menu", () => {
  it("offers Import Files… as a real entry", async () => {
    renderShellWithLibrary([makeBook()]);
    await screen.findByTestId("library-header");

    await userEvent.click(screen.getByTestId("import-menu"));
    const filesItem = await screen.findByRole("menuitem", { name: "Import Files…" });
    expect(filesItem).not.toHaveAttribute("aria-disabled");
  });

  it("offers the folder picker from the empty library state", async () => {
    pickDirectoryMock.mockResolvedValue("/first/library");
    renderShellWithLibrary([], { imported: 4, updated: 0, failed: [] });
    await screen.findByTestId("empty-library");

    await userEvent.click(screen.getByTestId("empty-library-import"));

    expect(invokeMock).toHaveBeenCalledWith("import_paths", { paths: ["/first/library"] });
    expect(await screen.findByTestId("import-status")).toHaveTextContent("Imported 4 new");
  });

  it("imports the picked folder through import_paths and reports the result", async () => {
    pickDirectoryMock.mockResolvedValue("/picked/books");
    renderShellWithLibrary([makeBook()], { imported: 2, updated: 1, failed: [] });
    await screen.findByTestId("library-header");

    await userEvent.click(screen.getByTestId("import-menu"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Import Folder…" }));

    expect(invokeMock).toHaveBeenCalledWith("import_paths", { paths: ["/picked/books"] });

    const status = await screen.findByTestId("import-status");
    expect(status).toHaveTextContent("Imported 2 new, updated 1");

    // The shared library data refreshed after the import.
    const listCalls = invokeMock.mock.calls.filter(([command]) => command === "list_books");
    expect(listCalls.length).toBeGreaterThanOrEqual(2);

    await userEvent.click(screen.getByRole("button", { name: "Dismiss import status" }));
    expect(screen.queryByTestId("import-status")).not.toBeInTheDocument();
  });

  it("imports picked files through import_paths", async () => {
    pickBookFilesMock.mockResolvedValue(["/a/one.epub", "/b/two.pdf"]);
    renderShellWithLibrary([makeBook()], { imported: 2, updated: 0, failed: [] });
    await screen.findByTestId("library-header");

    await userEvent.click(screen.getByTestId("import-menu"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Import Files…" }));

    expect(invokeMock).toHaveBeenCalledWith("import_paths", {
      paths: ["/a/one.epub", "/b/two.pdf"],
    });
    expect(await screen.findByTestId("import-status")).toHaveTextContent("Imported 2 new");
  });

  it("shows a summary without pretending success when nothing was imported", async () => {
    pickDirectoryMock.mockResolvedValue("/picked/empty");
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      list_collections: [],
      import_paths: { imported: 0, updated: 0, failed: [] },
    });

    render(<AppShell />);
    await screen.findByTestId("library-header");

    await userEvent.click(screen.getByTestId("import-menu"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Import Folder…" }));

    expect(await screen.findByTestId("import-status")).toHaveTextContent("No new books found");
  });

  it("surfaces per-path failures from the report", async () => {
    pickDirectoryMock.mockResolvedValue("/picked/stray.epub");
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      list_collections: [],
      import_paths: {
        imported: 0,
        updated: 0,
        failed: [{ path: "/picked/stray.epub", error: "not a supported book file (.epub/.pdf)" }],
      },
    });

    render(<AppShell />);
    await screen.findByTestId("library-header");

    await userEvent.click(screen.getByTestId("import-menu"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Import Folder…" }));

    const status = await screen.findByTestId("import-status");
    expect(status).toHaveTextContent("No new books found");
    expect(status).toHaveTextContent("1 item could not be imported");
    expect(status).toHaveTextContent("/picked/stray.epub");
  });
});

describe("Import via drag-and-drop", () => {
  it("shows the overlay while dragging and imports dropped paths", async () => {
    renderShellWithLibrary([], { imported: 1, updated: 0, failed: [] });
    await screen.findByTestId("empty-library");

    const files = [new File([], "books")];
    await dragEnter(files);
    expect(await screen.findByTestId("dropzone-overlay")).toBeInTheDocument();

    await dragDrop(files);
    expect(invokeMock).toHaveBeenCalledWith("import_paths", { paths: ["/dropped/books"] });
    expect(await screen.findByTestId("import-status")).toHaveTextContent("Imported 1 new");
    expect(screen.queryByTestId("dropzone-overlay")).not.toBeInTheDocument();
  });

  it("collects a failure for dropped entries the backend cannot import", async () => {
    renderShellWithLibrary([], {
      imported: 0,
      updated: 0,
      failed: [{ path: "/dropped/loose.epub", error: "not a supported book file (.epub/.pdf)" }],
    });
    await screen.findByTestId("empty-library");

    const loose = new File([], "loose.epub");
    await dragEnter([loose]);
    await dragDrop([loose]);

    const status = await screen.findByTestId("import-status");
    expect(status).toHaveTextContent("1 item could not be imported");
    expect(status).toHaveTextContent("/dropped/loose.epub");
  });

  it("resolves dropped files to absolute paths through the preload", async () => {
    renderShellWithLibrary([], { imported: 1, updated: 0, failed: [] });
    await screen.findByTestId("empty-library");
    pathForFileMock.mockReturnValueOnce("/elsewhere/dropped.epub");

    const files = [new File([], "dropped.epub")];
    await dragEnter(files);
    await dragDrop(files);

    expect(invokeMock).toHaveBeenCalledWith("import_paths", { paths: ["/elsewhere/dropped.epub"] });
    await screen.findByTestId("import-status");
  });
});
