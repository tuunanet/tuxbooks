import { contextBridge, ipcRenderer, webUtils } from "electron";

import {
  IPC_CHANNELS,
  isStorageRootId,
  isValidBookFormat,
  isValidBookId,
} from "../shared/pathSchema";

/**
 * The preload bridge (docs/ARCHITECTURE.md): the renderer's entire view of
 * the outside world. contextIsolation is on, the sandbox is on, and this
 * surface is explicitly enumerated — no raw ipcRenderer passthrough, no
 * arbitrary method names. Arguments to identity-bearing calls are validated
 * against the shared path/query schema before they ever reach the main
 * process. The renderer-side typed wrappers live in
 * `frontend/src/lib/bridge.ts`.
 */

const api = {
  /** One whitelisted JSON-RPC call to the Rust service. */
  invoke(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return ipcRenderer.invoke(IPC_CHANNELS.invoke, method, params ?? {});
  },

  /**
   * Subscribe to a service event (`library-changed`, `import-progress`).
   * Main sends `{channel, name, payload}`; only the payload of the requested
   * name is forwarded. Returns the unsubscribe function.
   */
  onEvent(name: string, callback: (payload: unknown) => void): () => void {
    const listener = (_event: unknown, eventName: string, payload: unknown): void => {
      if (eventName === name) callback(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.event, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.event, listener);
  },

  /** Native folder picker; null when cancelled. */
  pickDirectory(): Promise<string | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.dialog, "directory");
  },

  /** Native single-file picker (relocate a missing book); null when cancelled. */
  pickBookFile(): Promise<string | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.dialog, "book-file");
  },

  /** Native multi-file picker (Import Files…); empty when cancelled. */
  pickBookFiles(): Promise<string[]> {
    return ipcRenderer.invoke(IPC_CHANNELS.dialog, "book-files");
  },

  /** Native image picker for cover overrides; null when cancelled. */
  pickCoverImage(): Promise<string | null> {
    return ipcRenderer.invoke(IPC_CHANNELS.dialog, "cover-image");
  },

  /** Reveal a stored book's file in the system file manager (by book id). */
  revealBook(bookId: number): Promise<void> {
    if (!isValidBookId(bookId)) {
      return Promise.reject(new TypeError(`invalid book id: ${String(bookId)}`));
    }
    return ipcRenderer.invoke(IPC_CHANNELS.reveal, bookId);
  },

  /** App-owned storage report (data root, config root, sizes). */
  storageReport(): Promise<unknown> {
    return ipcRenderer.invoke(IPC_CHANNELS.storageReport);
  },

  /** Open one app-owned storage root in the system file manager, by stable id. */
  openDataFolder(rootId: string): Promise<void> {
    if (!isStorageRootId(rootId)) {
      return Promise.reject(new TypeError(`invalid data folder id: ${String(rootId)}`));
    }
    return ipcRenderer.invoke(IPC_CHANNELS.openDataFolder, rootId);
  },

  /** Remove the regenerable browser caches and GPU marker; resolves bytes freed. */
  clearCache(): Promise<number> {
    return ipcRenderer.invoke(IPC_CHANNELS.clearCache) as Promise<number>;
  },

  /**
   * Raw bytes of a stored book's source file, fetched over the scoped
   * `tuxbooks://` protocol (range-capable, never base64 through IPC).
   */
  async fetchBookBytes(bookId: number, format: string): Promise<ArrayBuffer> {
    if (!isValidBookId(bookId) || !isValidBookFormat(format)) {
      throw new TypeError(`invalid book request: ${String(bookId)} ${String(format)}`);
    }
    const response = await fetch(`tuxbooks://book/${bookId}?format=${format}`);
    if (!response.ok) {
      throw new Error(`failed to load book ${bookId}: ${response.status}`);
    }
    return response.arrayBuffer();
  },

  /** Absolute path of a dropped File (sandbox-safe; File.path is gone). */
  pathForFile(file: File): string {
    return webUtils.getPathForFile(file);
  },
};

export type TuxbooksPreloadApi = typeof api;

contextBridge.exposeInMainWorld("tuxbooks", api);
