import {
  IPC_CHANNELS,
  isAllowedSenderUrl,
  isStorageRootId,
  isValidBookId,
} from "../shared/pathSchema";
import { IssuedPaths, validateInvokeParams } from "./ipcPolicy";
import { Sidecar, SidecarError } from "./sidecar";
import { buildStorageReport, type StorageDirs } from "./storageSizing";
import type { LibraryStorageStats } from "../shared/storageReport";

/**
 * The renderer-facing ipcMain handlers (docs/ARCHITECTURE.md, issue #84):
 * `tuxbooks:invoke`, the native dialogs, and reveal. Registration and the
 * native surfaces are injected so the wiring is unit-testable without
 * Electron. Every channel a publication frame can reach checks the sender
 * first (T-6): the preload bridge is exposed to sandboxed EPUB frames, so
 * a hostile book must not pop native dialogs or reveal stored paths.
 */

/** The native dialog surface the handlers use; injected from the main process. */
export interface NativeDialogSurface {
  showOpenDialog(options: {
    title: string;
    properties: Array<"openFile" | "openDirectory" | "multiSelections">;
    filters?: { name: string; extensions: string[] }[];
  }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

/** The native shell surface the handlers use; injected from the main process. */
export interface NativeShellSurface {
  showItemInFolder(fullPath: string): void;
  openPath(fullPath: string): Promise<string>;
}

/** Minimal sender view of the Electron IPC event. */
export interface SenderEvent {
  readonly senderFrame?: { readonly url: string } | null;
}

export type IpcHandler = (event: SenderEvent, ...args: unknown[]) => unknown;

export interface IpcHandlerDeps {
  sidecar: Pick<Sidecar, "call">;
  issued: IssuedPaths;
  dialog: NativeDialogSurface;
  shell: NativeShellSurface;
  storageDirs: StorageDirs;
  debugIpc: boolean;
  debugLog?: (line: string) => void;
}

/** The sender must be the application page, on every channel (T-6). */
function requireAppSender(event: SenderEvent): void {
  const senderUrl = event.senderFrame?.url ?? "";
  if (!isAllowedSenderUrl(senderUrl, process.env.VITE_DEV_SERVER_URL)) {
    throw new SidecarError("sender is not the application page");
  }
}

/** Register the invoke, dialog, reveal, and storage handlers on `register`. */
export function registerIpcHandlers(
  register: (channel: string, handler: IpcHandler) => void,
  deps: IpcHandlerDeps,
): void {
  const { sidecar, issued, dialog, shell, storageDirs, debugIpc, debugLog } = deps;

  register(IPC_CHANNELS.invoke, async (event, method: unknown, params: unknown) => {
    requireAppSender(event);
    if (typeof method !== "string") {
      throw new SidecarError(`method not allowed: ${String(method)}`);
    }
    try {
      validateInvokeParams(method, params, issued);
    } catch (error) {
      throw new SidecarError((error as Error).message);
    }
    if (debugIpc) {
      debugLog?.(`ipc ${method}`);
      console.log(`[ipc] ${method}`);
    }
    return sidecar.call(method, params as Record<string, unknown>);
  });

  register(IPC_CHANNELS.dialog, async (event, kind: unknown) => {
    requireAppSender(event);
    if (kind === "directory") {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "Choose a folder to import",
      });
      const picked = result.filePaths[0];
      if (result.canceled || picked === undefined) return null;
      issued.issue("directory", picked);
      return picked;
    }
    if (kind === "book-file") {
      const result = await dialog.showOpenDialog({
        properties: ["openFile"],
        title: "Locate the book file",
        filters: [{ name: "Ebooks", extensions: ["epub", "pdf"] }],
      });
      const picked = result.filePaths[0];
      if (result.canceled || picked === undefined) return null;
      issued.issue("book-file", picked);
      return picked;
    }
    if (kind === "book-files") {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", "multiSelections"],
        title: "Choose book files to import",
        filters: [{ name: "Ebooks", extensions: ["epub", "pdf"] }],
      });
      if (result.canceled) return [];
      for (const filePath of result.filePaths) issued.issue("book-files", filePath);
      return result.filePaths;
    }
    if (kind === "cover-image") {
      const result = await dialog.showOpenDialog({
        properties: ["openFile"],
        title: "Choose a cover image",
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
      });
      const picked = result.filePaths[0];
      if (result.canceled || picked === undefined) return null;
      issued.issue("cover-image", picked);
      return picked;
    }
    throw new SidecarError(`unknown dialog kind: ${String(kind)}`);
  });

  register(IPC_CHANNELS.reveal, async (event, bookId: unknown) => {
    requireAppSender(event);
    if (!isValidBookId(bookId)) {
      throw new SidecarError("reveal requires a book id");
    }
    // The path is resolved here from the library database; the renderer
    // never supplies one (issue #84 T-1).
    const books = (await sidecar.call("list_books")) as Array<{ id: number; path: string }>;
    const book = books.find((candidate) => candidate.id === bookId);
    if (!book) {
      throw new SidecarError(`no book ${bookId}`);
    }
    shell.showItemInFolder(book.path);
  });

  register(IPC_CHANNELS.storageReport, async (event) => {
    requireAppSender(event);
    // The watched locations and catalog counts come from the sidecar; main
    // sizes its own data roots and folds both into one report.
    const library = (await sidecar.call("get_storage_stats")) as LibraryStorageStats;
    return buildStorageReport(storageDirs, library);
  });

  register(IPC_CHANNELS.openDataFolder, async (event, rootId: unknown) => {
    requireAppSender(event);
    // The renderer names a stable root id; main resolves the real path and
    // never accepts one from the renderer (data-management spec).
    if (!isStorageRootId(rootId)) {
      throw new SidecarError("open requires a known data folder id");
    }
    const target = rootId === "app-data" ? storageDirs.dataDir : storageDirs.configDir;
    await shell.openPath(target);
  });
}
