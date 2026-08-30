import { act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

type DragEventPayload =
  | { type: "enter"; paths: string[]; position: { x: number; y: number } }
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };

type DragHandler = (event: { payload: DragEventPayload }) => void;

const webviewMocks = vi.hoisted(() => ({
  onDragDropEvent: vi.fn<
    (handler: (event: { payload: DragEventPayload }) => void) => Promise<() => void>
  >(() => Promise.resolve(() => {})),
}));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: webviewMocks.onDragDropEvent }),
}));

import { open } from "@tauri-apps/plugin-dialog";
import { AppShell } from "@/components/layout/AppShell";
import { makeBook } from "./factories";
import { invokeMock, mockInvoke } from "./mocks/tauri";

function renderShellWithLibrary(
  books: ReturnType<typeof makeBook>[] = [],
  scanLibrary: unknown = { imported: 0, updated: 0, failed: [] },
) {
  mockInvoke({
    get_library_stats: { bookCount: books.length, collectionCount: 0 },
    list_books: books,
    scan_library: scanLibrary,
  });
  return render(<AppShell />);
}

function captureDragHandler(): DragHandler {
  const registration = webviewMocks.onDragDropEvent.mock.calls.at(-1);
  if (!registration) throw new Error("onDragDropEvent was not called");
  return registration[0];
}

describe("Import via the header menu", () => {
  it("keeps single-file import as an honest placeholder", async () => {
    renderShellWithLibrary([makeBook()]);
    await screen.findByTestId("library-header");

    await userEvent.click(screen.getByTestId("import-menu"));
    const filesItem = await screen.findByRole("menuitem", { name: "Import Files…" });
    expect(filesItem).toHaveAttribute("aria-disabled", "true");
  });

  it("offers the folder picker from the empty library state", async () => {
    vi.mocked(open).mockResolvedValue("/first/library");
    renderShellWithLibrary([], { imported: 4, updated: 0, failed: [] });
    await screen.findByTestId("empty-library");

    await userEvent.click(screen.getByTestId("empty-library-import"));

    expect(invokeMock).toHaveBeenCalledWith("scan_library", { path: "/first/library" });
    expect(await screen.findByTestId("import-status")).toHaveTextContent("Imported 4 new");
  });

  it("imports the picked folder through scan_library and reports the result", async () => {
    vi.mocked(open).mockResolvedValue("/picked/books");
    renderShellWithLibrary([makeBook()], { imported: 2, updated: 1, failed: [] });
    await screen.findByTestId("library-header");

    await userEvent.click(screen.getByTestId("import-menu"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Import Folder…" }));

    expect(invokeMock).toHaveBeenCalledWith("scan_library", { path: "/picked/books" });

    const status = await screen.findByTestId("import-status");
    expect(status).toHaveTextContent("Imported 2 new, updated 1");

    // The shared library data refreshed after the import.
    const listCalls = invokeMock.mock.calls.filter(([command]) => command === "list_books");
    expect(listCalls.length).toBeGreaterThanOrEqual(2);

    await userEvent.click(screen.getByRole("button", { name: "Dismiss import status" }));
    expect(screen.queryByTestId("import-status")).not.toBeInTheDocument();
  });

  it("shows a summary without pretending success when nothing was imported", async () => {
    vi.mocked(open).mockResolvedValue("/picked/empty");
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      scan_library: { imported: 0, updated: 0, failed: [] },
    });

    render(<AppShell />);
    await screen.findByTestId("library-header");

    await userEvent.click(screen.getByTestId("import-menu"));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Import Folder…" }));

    expect(await screen.findByTestId("import-status")).toHaveTextContent("No new books found");
  });

  it("surfaces per-path failures honestly", async () => {
    vi.mocked(open).mockResolvedValue("/picked/stray.epub");
    invokeMock.mockImplementation((command: string, args?: unknown) => {
      if (command === "scan_library") {
        const path = (args as { path?: string } | undefined)?.path;
        return Promise.reject(new Error(`library path is not a directory: ${path}`));
      }
      return command === "get_library_stats"
        ? Promise.resolve({ bookCount: 1, collectionCount: 0 })
        : Promise.resolve([makeBook()]);
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

    const dragHandler = captureDragHandler();

    await act(async () => {
      dragHandler({ payload: { type: "enter", paths: [], position: { x: 0, y: 0 } } });
    });
    expect(await screen.findByTestId("dropzone-overlay")).toBeInTheDocument();

    await act(async () => {
      dragHandler({ payload: { type: "leave" } });
    });
    expect(screen.queryByTestId("dropzone-overlay")).not.toBeInTheDocument();

    await act(async () => {
      dragHandler({ payload: { type: "enter", paths: [], position: { x: 1, y: 1 } } });
      dragHandler({
        payload: { type: "drop", paths: ["/dropped/books"], position: { x: 5, y: 5 } },
      });
    });

    expect(invokeMock).toHaveBeenCalledWith("scan_library", { path: "/dropped/books" });
    expect(await screen.findByTestId("import-status")).toHaveTextContent("Imported 1 new");
    expect(screen.queryByTestId("dropzone-overlay")).not.toBeInTheDocument();
  });

  it("collects a failure for dropped entries the backend cannot import", async () => {
    renderShellWithLibrary();
    await screen.findByTestId("empty-library");
    invokeMock.mockImplementation((command: string, args?: unknown) => {
      if (command === "scan_library") {
        const path = (args as { path?: string } | undefined)?.path;
        return Promise.reject(new Error(`library path is not a directory: ${path}`));
      }
      return command === "get_library_stats"
        ? Promise.resolve({ bookCount: 0, collectionCount: 0 })
        : Promise.resolve([]);
    });

    const dragHandler = captureDragHandler();
    await act(async () => {
      dragHandler({
        payload: { type: "drop", paths: ["/dropped/loose.epub"], position: { x: 5, y: 5 } },
      });
    });

    const status = await screen.findByTestId("import-status");
    expect(status).toHaveTextContent("1 item could not be imported");
    expect(status).toHaveTextContent("/dropped/loose.epub");
  });
});
