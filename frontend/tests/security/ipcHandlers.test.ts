import { describe, expect, it, vi } from "vitest";

import { registerIpcHandlers, type IpcHandler } from "../../../electron/main/ipcHandlers";
import { IssuedPaths } from "../../../electron/main/ipcPolicy";
import { IPC_CHANNELS } from "../../../electron/shared/pathSchema";
import type { StorageReport } from "../../../electron/shared/storageReport";

const ALLOWED = "app://bundle/index.html";
const HOSTILE = "app://evil/index.html";

const STORAGE_DIRS = { dataDir: "/app/data", configDir: "/app/config" };

const LIBRARY_STATS = {
  locations: [
    { path: "/books", addedAt: "2026-01-01T00:00:00.000Z", bookCount: 2, totalBytes: 3_000_000 },
  ],
  bookTotalBytes: 3_000_000,
  catalog: { books: 2, authors: 1, collections: 0, annotations: 0, readingProgress: 0 },
};

const ALL_CHANNELS = [
  IPC_CHANNELS.invoke,
  IPC_CHANNELS.dialog,
  IPC_CHANNELS.reveal,
  IPC_CHANNELS.storageReport,
  IPC_CHANNELS.openDataFolder,
];

function senderEvent(url: string): { senderFrame: { url: string } } {
  return { senderFrame: { url } };
}

function argsFor(channel: string): unknown[] {
  if (channel === IPC_CHANNELS.invoke) return ["list_books", {}];
  if (channel === IPC_CHANNELS.dialog) return ["directory"];
  if (channel === IPC_CHANNELS.storageReport) return [];
  if (channel === IPC_CHANNELS.openDataFolder) return ["app-data"];
  return [3];
}

function harness(): {
  handlers: Map<string, IpcHandler>;
  sidecar: { call: ReturnType<typeof vi.fn> };
  dialog: { showOpenDialog: ReturnType<typeof vi.fn> };
  shell: {
    showItemInFolder: ReturnType<typeof vi.fn>;
    openPath: ReturnType<typeof vi.fn>;
  };
} {
  const handlers = new Map<string, IpcHandler>();
  const sidecar = {
    call: vi.fn(async (method: string) => {
      if (method === "list_books") return [{ id: 3, path: "/library/3.epub" }];
      if (method === "get_storage_stats") return LIBRARY_STATS;
      return {};
    }),
  };
  const dialog = {
    showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ["/picked/one.epub"] })),
  };
  const shell = { showItemInFolder: vi.fn(), openPath: vi.fn(async () => "") };
  registerIpcHandlers((channel, handler) => handlers.set(channel, handler), {
    sidecar,
    issued: new IssuedPaths(),
    dialog,
    shell,
    storageDirs: STORAGE_DIRS,
    debugIpc: false,
  });
  return { handlers, sidecar, dialog, shell };
}

describe("ipcHandlers (every renderer-facing channel gates its sender, T-6)", () => {
  it.each(ALL_CHANNELS)(
    "%s rejects a disallowed sender before touching anything native",
    async (channel) => {
      const { handlers, sidecar, dialog, shell } = harness();
      const handler = handlers.get(channel);
      expect(handler).toBeDefined();
      await expect(handler!(senderEvent(HOSTILE) as never, ...argsFor(channel))).rejects.toThrow(
        /sender/,
      );
      expect(sidecar.call).not.toHaveBeenCalled();
      expect(dialog.showOpenDialog).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
      expect(shell.openPath).not.toHaveBeenCalled();
    },
  );

  it.each(ALL_CHANNELS)("%s admits the application page", async (channel) => {
    const { handlers, sidecar, dialog, shell } = harness();
    const handler = handlers.get(channel);
    expect(handler).toBeDefined();
    await handler!(senderEvent(ALLOWED) as never, ...argsFor(channel));
    if (channel === IPC_CHANNELS.dialog) {
      expect(dialog.showOpenDialog).toHaveBeenCalledOnce();
    }
    if (channel === IPC_CHANNELS.reveal) {
      expect(shell.showItemInFolder).toHaveBeenCalledWith("/library/3.epub");
      expect(sidecar.call).toHaveBeenCalledWith("list_books");
    }
    if (channel === IPC_CHANNELS.invoke) {
      expect(sidecar.call).toHaveBeenCalled();
    }
    if (channel === IPC_CHANNELS.openDataFolder) {
      expect(shell.openPath).toHaveBeenCalledWith(STORAGE_DIRS.dataDir);
    }
  });
});

describe("storage report channel (data-management spec)", () => {
  it("returns the report shape to the application page", async () => {
    const { handlers, sidecar } = harness();
    const handler = handlers.get(IPC_CHANNELS.storageReport);
    const report = (await handler!(senderEvent(ALLOWED) as never)) as StorageReport;
    expect(report.roots.map((root) => root.id)).toEqual(["app-data", "app-config"]);
    for (const root of report.roots) {
      expect(typeof root.label).toBe("string");
      expect(typeof root.path).toBe("string");
      expect(typeof root.sizeBytes).toBe("number");
      expect(Array.isArray(root.entries)).toBe(true);
    }
    expect(sidecar.call).toHaveBeenCalledWith("get_storage_stats");
    expect(report.bookLocations).toEqual(LIBRARY_STATS.locations);
    expect(report.bookTotalBytes).toBe(LIBRARY_STATS.bookTotalBytes);
    expect(report.catalog).toEqual(LIBRARY_STATS.catalog);
  });

  it("opens a root by id and rejects a renderer-supplied path", async () => {
    const { handlers, shell } = harness();
    const handler = handlers.get(IPC_CHANNELS.openDataFolder);
    expect(handler).toBeDefined();

    await handler!(senderEvent(ALLOWED) as never, "app-config");
    expect(shell.openPath).toHaveBeenCalledWith(STORAGE_DIRS.configDir);

    shell.openPath.mockClear();
    await expect(handler!(senderEvent(ALLOWED) as never, "/etc/passwd")).rejects.toThrow(
      /data folder id/,
    );
    await expect(handler!(senderEvent(ALLOWED) as never, "app-data/../app-config")).rejects.toThrow(
      /data folder id/,
    );
    expect(shell.openPath).not.toHaveBeenCalled();
  });
});
