import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GPU_FALLBACK_MARKER } from "../../../electron/main/gpuFallback";
import { registerIpcHandlers, type IpcHandler } from "../../../electron/main/ipcHandlers";
import { IssuedPaths } from "../../../electron/main/ipcPolicy";
import type { StorageDirs } from "../../../electron/main/storageSizing";
import { IPC_CHANNELS } from "../../../electron/shared/pathSchema";
import type { StorageReport } from "../../../electron/shared/storageReport";

const ALLOWED = "app://bundle/index.html";
const HOSTILE = "app://evil/index.html";

const STORAGE_DIRS: StorageDirs = {
  dataDir: path.join(os.tmpdir(), `ipc-handlers-missing-data-${process.pid}`),
  configDir: path.join(os.tmpdir(), `ipc-handlers-missing-config-${process.pid}`),
};

const LIBRARY_STATS = {
  locations: [
    {
      id: 1,
      path: "/books",
      addedAt: "2026-01-01T00:00:00.000Z",
      bookCount: 2,
      totalBytes: 3_000_000,
    },
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
  IPC_CHANNELS.openLibraryLocation,
  IPC_CHANNELS.copyDataPath,
  IPC_CHANNELS.copyLibraryLocationPath,
  IPC_CHANNELS.clearCache,
];

function senderEvent(url: string): { senderFrame: { url: string } } {
  return { senderFrame: { url } };
}

function argsFor(channel: string): unknown[] {
  if (channel === IPC_CHANNELS.invoke) return ["list_books", {}];
  if (channel === IPC_CHANNELS.dialog) return ["directory"];
  if (channel === IPC_CHANNELS.storageReport) return [];
  if (channel === IPC_CHANNELS.openDataFolder) return ["app-data"];
  if (channel === IPC_CHANNELS.openLibraryLocation) return [1];
  if (channel === IPC_CHANNELS.copyDataPath) return ["app-data"];
  if (channel === IPC_CHANNELS.copyLibraryLocationPath) return [1];
  if (channel === IPC_CHANNELS.clearCache) return [];
  return [3];
}

function harness(storageDirs: StorageDirs = STORAGE_DIRS): {
  handlers: Map<string, IpcHandler>;
  sidecar: { call: ReturnType<typeof vi.fn> };
  dialog: { showOpenDialog: ReturnType<typeof vi.fn> };
  shell: {
    showItemInFolder: ReturnType<typeof vi.fn>;
    openPath: ReturnType<typeof vi.fn>;
  };
  clipboard: { writeText: ReturnType<typeof vi.fn> };
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
  const clipboard = { writeText: vi.fn() };
  registerIpcHandlers((channel, handler) => handlers.set(channel, handler), {
    sidecar,
    issued: new IssuedPaths(),
    dialog,
    shell,
    clipboard,
    storageDirs,
    debugIpc: false,
  });
  return { handlers, sidecar, dialog, shell, clipboard };
}

describe("ipcHandlers (every renderer-facing channel gates its sender, T-6)", () => {
  it.each(ALL_CHANNELS)(
    "%s rejects a disallowed sender before touching anything native",
    async (channel) => {
      const { handlers, sidecar, dialog, shell, clipboard } = harness();
      const handler = handlers.get(channel);
      expect(handler).toBeDefined();
      await expect(handler!(senderEvent(HOSTILE) as never, ...argsFor(channel))).rejects.toThrow(
        /sender/,
      );
      expect(sidecar.call).not.toHaveBeenCalled();
      expect(dialog.showOpenDialog).not.toHaveBeenCalled();
      expect(shell.showItemInFolder).not.toHaveBeenCalled();
      expect(shell.openPath).not.toHaveBeenCalled();
      expect(clipboard.writeText).not.toHaveBeenCalled();
    },
  );

  it.each(ALL_CHANNELS)("%s admits the application page", async (channel) => {
    const { handlers, sidecar, dialog, shell, clipboard } = harness();
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
    if (channel === IPC_CHANNELS.openLibraryLocation) {
      expect(shell.openPath).toHaveBeenCalledWith("/books");
    }
    if (channel === IPC_CHANNELS.copyDataPath) {
      expect(clipboard.writeText).toHaveBeenCalledWith(STORAGE_DIRS.dataDir);
    }
    if (channel === IPC_CHANNELS.copyLibraryLocationPath) {
      expect(clipboard.writeText).toHaveBeenCalledWith("/books");
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

describe("open library location channel (data-management spec)", () => {
  it("resolves a watched location by id and rejects a renderer-supplied path", async () => {
    const { handlers, shell } = harness();
    const handler = handlers.get(IPC_CHANNELS.openLibraryLocation);
    expect(handler).toBeDefined();

    await handler!(senderEvent(ALLOWED) as never, 1);
    expect(shell.openPath).toHaveBeenCalledWith("/books");

    shell.openPath.mockClear();
    await expect(handler!(senderEvent(ALLOWED) as never, "/books")).rejects.toThrow(
      /library location id/,
    );
    await expect(handler!(senderEvent(ALLOWED) as never, 0)).rejects.toThrow(/library location id/);
    await expect(handler!(senderEvent(ALLOWED) as never, 99)).rejects.toThrow(
      /no library location 99/,
    );
    expect(shell.openPath).not.toHaveBeenCalled();
  });
});

describe("copy data path channel (data-management spec)", () => {
  it("copies a root by id and rejects a renderer-supplied path", async () => {
    const { handlers, clipboard } = harness();
    const handler = handlers.get(IPC_CHANNELS.copyDataPath);
    expect(handler).toBeDefined();

    await handler!(senderEvent(ALLOWED) as never, "app-config");
    expect(clipboard.writeText).toHaveBeenCalledWith(STORAGE_DIRS.configDir);

    clipboard.writeText.mockClear();
    await expect(handler!(senderEvent(ALLOWED) as never, "/etc/passwd")).rejects.toThrow(
      /data folder id/,
    );
    await expect(handler!(senderEvent(ALLOWED) as never, "app-data/../app-config")).rejects.toThrow(
      /data folder id/,
    );
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });
});

describe("copy library location path channel (data-management spec)", () => {
  it("copies a watched location by id and rejects a renderer-supplied path", async () => {
    const { handlers, clipboard } = harness();
    const handler = handlers.get(IPC_CHANNELS.copyLibraryLocationPath);
    expect(handler).toBeDefined();

    await handler!(senderEvent(ALLOWED) as never, 1);
    expect(clipboard.writeText).toHaveBeenCalledWith("/books");

    clipboard.writeText.mockClear();
    await expect(handler!(senderEvent(ALLOWED) as never, "/books")).rejects.toThrow(
      /library location id/,
    );
    await expect(handler!(senderEvent(ALLOWED) as never, 0)).rejects.toThrow(/library location id/);
    await expect(handler!(senderEvent(ALLOWED) as never, 99)).rejects.toThrow(
      /no library location 99/,
    );
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });
});

describe("cache clear channel (data-management spec)", () => {
  let dataDir: string;
  let configDir: string;

  function write(filePath: string, bytes: number): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, Buffer.alloc(bytes, 1));
  }

  async function clear(dirs: StorageDirs): Promise<number> {
    const { handlers } = harness(dirs);
    const handler = handlers.get(IPC_CHANNELS.clearCache);
    expect(handler).toBeDefined();
    return (await handler!(senderEvent(ALLOWED) as never)) as number;
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-data-"));
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-config-"));
  });

  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("removes only the browser caches and GPU marker and frees their bytes", async () => {
    write(path.join(configDir, "Cache", "a"), 400);
    write(path.join(configDir, "GPUCache", "b"), 100);
    write(path.join(configDir, "Preferences"), 7);
    write(path.join(configDir, "Local Storage", "state"), 8);
    write(path.join(dataDir, "tuxbooks.db"), 1000);
    write(path.join(dataDir, "tuxbooks.db-wal"), 40);
    write(path.join(dataDir, "covers", "cover.png"), 300);
    write(path.join(dataDir, GPU_FALLBACK_MARKER), 5);
    write(path.join(dataDir, "book.epub"), 500);

    const freed = await clear({ dataDir, configDir });

    expect(freed).toBe(505);
    expect(fs.existsSync(path.join(configDir, "Cache"))).toBe(false);
    expect(fs.existsSync(path.join(configDir, "GPUCache"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, GPU_FALLBACK_MARKER))).toBe(false);

    expect(fs.existsSync(path.join(configDir, "Preferences"))).toBe(true);
    expect(fs.existsSync(path.join(configDir, "Local Storage", "state"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "tuxbooks.db"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "tuxbooks.db-wal"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "covers", "cover.png"))).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "book.epub"))).toBe(true);
  });

  it("refuses a cache target that is a symlink out of the root", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "clear-outside-"));
    write(path.join(outside, "secret"), 9999);
    try {
      fs.symlinkSync(outside, path.join(configDir, "Cache"), "dir");
    } catch {
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }
    try {
      const freed = await clear({ dataDir, configDir });
      expect(freed).toBe(0);
      expect(fs.existsSync(path.join(outside, "secret"))).toBe(true);
      expect(fs.existsSync(path.join(configDir, "Cache"))).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not follow a symlink planted inside a cache directory", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "clear-outside-"));
    write(path.join(outside, "secret"), 9999);
    write(path.join(configDir, "Cache", "real"), 100);
    try {
      fs.symlinkSync(path.join(outside, "secret"), path.join(configDir, "Cache", "link"));
    } catch {
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }
    try {
      const freed = await clear({ dataDir, configDir });
      expect(freed).toBe(100);
      expect(fs.existsSync(path.join(configDir, "Cache"))).toBe(false);
      expect(fs.existsSync(path.join(outside, "secret"))).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
