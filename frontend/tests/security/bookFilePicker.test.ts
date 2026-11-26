import { describe, expect, it, vi } from "vite-plus/test";

import { registerIpcHandlers, type IpcHandler } from "../../../electron/main/ipcHandlers";
import { IssuedPaths } from "../../../electron/main/ipcPolicy";
import { IPC_CHANNELS } from "../../../electron/shared/pathSchema";

const ALLOWED = "app://bundle/index.html";
const HOSTILE = "app://evil/index.html";

/** The trash the sidecar reports: one with a known path, one without. */
const TRASH_ENTRIES = [
  { id: 7, title: "Moby Dick", lastKnownPath: "/books/fiction/moby.epub" },
  { id: 9, title: "Dracula", lastKnownPath: null },
];

const EBOOK_FILTERS = [{ name: "Ebooks", extensions: ["epub", "pdf"] }];

function senderEvent(url: string): { senderFrame: { url: string } } {
  return { senderFrame: { url } };
}

function harness(): {
  handlers: Map<string, IpcHandler>;
  sidecar: { call: ReturnType<typeof vi.fn> };
  dialog: { showOpenDialog: ReturnType<typeof vi.fn> };
} {
  const handlers = new Map<string, IpcHandler>();
  const sidecar = {
    call: vi.fn(async (method: string) => {
      if (method === "list_book_trash") return TRASH_ENTRIES;
      return {};
    }),
  };
  const dialog = {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["/picked/one.epub"] })),
  };
  registerIpcHandlers((channel, handler) => handlers.set(channel, handler), {
    sidecar,
    issued: new IssuedPaths(),
    dialog,
    shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => "") },
    clipboard: { writeText: vi.fn() },
    storageDirs: { dataDir: "/data", configDir: "/config" },
    debugIpc: false,
  });
  return { handlers, sidecar, dialog };
}

describe("book-file picker from the trash entry (restore-from-trash spec)", () => {
  it("names the book, opens in its old folder, and issues the pick", async () => {
    const { handlers, sidecar, dialog } = harness();
    const picked = await handlers.get(IPC_CHANNELS.dialog)!(
      senderEvent(ALLOWED) as never,
      "book-file",
      7,
    );

    expect(dialog.showOpenDialog).toHaveBeenCalledOnce();
    expect(dialog.showOpenDialog).toHaveBeenCalledWith({
      properties: ["openFile"],
      title: 'Locate the file for "Moby Dick"',
      defaultPath: "/books/fiction",
      filters: EBOOK_FILTERS,
    });
    expect(picked).toBe("/picked/one.epub");

    // The pick is issued, so the combined restore command accepts it.
    await handlers.get(IPC_CHANNELS.invoke)!(senderEvent(ALLOWED) as never, "restore_book", {
      trashId: 7,
      pickedPath: "/picked/one.epub",
    });
    expect(sidecar.call).toHaveBeenCalledWith("restore_book", {
      trashId: 7,
      pickedPath: "/picked/one.epub",
    });
  });

  it("falls back to today's dialog when the entry no longer resolves", async () => {
    const { handlers, dialog } = harness();
    await handlers.get(IPC_CHANNELS.dialog)!(senderEvent(ALLOWED) as never, "book-file", 99);

    expect(dialog.showOpenDialog).toHaveBeenCalledWith({
      properties: ["openFile"],
      title: "Locate the book file",
      filters: EBOOK_FILTERS,
    });
  });

  it("names the book without a folder when the path is unknown", async () => {
    const { handlers, dialog } = harness();
    await handlers.get(IPC_CHANNELS.dialog)!(senderEvent(ALLOWED) as never, "book-file", 9);

    expect(dialog.showOpenDialog).toHaveBeenCalledWith({
      properties: ["openFile"],
      title: 'Locate the file for "Dracula"',
      filters: EBOOK_FILTERS,
    });
  });

  it("keeps today's argumentless dialog for the other callers", async () => {
    const { handlers, sidecar, dialog } = harness();
    await handlers.get(IPC_CHANNELS.dialog)!(senderEvent(ALLOWED) as never, "book-file");

    expect(dialog.showOpenDialog).toHaveBeenCalledWith({
      properties: ["openFile"],
      title: "Locate the book file",
      filters: EBOOK_FILTERS,
    });
    expect(sidecar.call).not.toHaveBeenCalled();
  });

  it("refuses a renderer-supplied path where the trash id belongs", async () => {
    const { handlers, dialog } = harness();
    const handler = handlers.get(IPC_CHANNELS.dialog)!;
    await expect(
      handler(senderEvent(ALLOWED) as never, "book-file", "/books/fiction/moby.epub"),
    ).rejects.toThrow(/trash entry id/);
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  });

  it("rejects a hostile sender before resolving the entry", async () => {
    const { handlers, sidecar, dialog } = harness();
    await expect(
      handlers.get(IPC_CHANNELS.dialog)!(senderEvent(HOSTILE) as never, "book-file", 7),
    ).rejects.toThrow(/sender/);
    expect(sidecar.call).not.toHaveBeenCalled();
    expect(dialog.showOpenDialog).not.toHaveBeenCalled();
  });
});
