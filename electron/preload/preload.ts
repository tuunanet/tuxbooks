import { contextBridge, ipcRenderer, webUtils } from "electron";

/**
 * The preload bridge (docs/ARCHITECTURE.md): the renderer's entire view of
 * the outside world. contextIsolation is on, the sandbox is on, and this
 * surface is explicitly enumerated — no raw ipcRenderer passthrough, no
 * arbitrary method names. The renderer-side typed wrappers live in
 * `frontend/src/lib/bridge.ts`.
 */

const api = {
  /** One whitelisted JSON-RPC call to the Rust service. */
  invoke(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return ipcRenderer.invoke("tuxbooks:invoke", method, params ?? {});
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
    ipcRenderer.on("tuxbooks:event", listener);
    return () => ipcRenderer.removeListener("tuxbooks:event", listener);
  },

  /** Native folder picker; null when cancelled. */
  pickDirectory(): Promise<string | null> {
    return ipcRenderer.invoke("tuxbooks:dialog", "directory");
  },

  /** Native single-file picker (relocate a missing book); null when cancelled. */
  pickBookFile(): Promise<string | null> {
    return ipcRenderer.invoke("tuxbooks:dialog", "book-file");
  },

  /** Native multi-file picker (Import Files…); empty when cancelled. */
  pickBookFiles(): Promise<string[]> {
    return ipcRenderer.invoke("tuxbooks:dialog", "book-files");
  },

  /** Native image picker for cover overrides; null when cancelled. */
  pickCoverImage(): Promise<string | null> {
    return ipcRenderer.invoke("tuxbooks:dialog", "cover-image");
  },

  /** Reveal a file in the system file manager (does not open it). */
  revealInFileManager(path: string): Promise<void> {
    return ipcRenderer.invoke("tuxbooks:reveal", path);
  },

  /**
   * Raw bytes of a stored book's source file, fetched over the scoped
   * `tuxbooks://` protocol (range-capable, never base64 through IPC).
   */
  async fetchBookBytes(bookId: number, format: string): Promise<ArrayBuffer> {
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
