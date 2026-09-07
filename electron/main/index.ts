import { protocol, app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { locateSidecar, RpcFailure, Sidecar, SidecarError } from "./sidecar";

/**
 * Electron main process (docs/architecture.md): window lifecycle, native
 * dialogs/shell, the scoped `tuxbooks://` resource protocol, and the Rust
 * sidecar. Plumbing only — no business logic.
 */

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:1420";

// CJS bundle: __dirname is electron/dist; asset paths below resolve from it.

/**
 * The renderer may only call these JSON-RPC methods through the bridge —
 * an explicit allowlist, not a passthrough.
 */
const SIDECAR_METHODS = new Set([
  "ping",
  "get_library_stats",
  "list_books",
  "search_books",
  "remove_book",
  "scan_library",
  "import_paths",
  "reconnect_book",
  "get_book_metadata",
  "update_book_metadata",
  "reset_book_metadata",
  "set_book_cover",
  "clear_book_cover_override",
  "get_reading_progress",
  "save_reading_progress",
  "mark_book_finished",
  "get_book_bytes",
  "list_collections",
  "create_collection",
  "delete_collection",
  "add_book_to_collection",
  "remove_book_from_collection",
  "list_annotations",
  "create_annotation",
  "update_annotation",
  "delete_annotation",
]);

// One library database owner: a second app instance quits immediately.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Registered before app ready so the privileged flags apply to every
// subsequent navigation and fetch. corsEnabled matters: the renderer origin
// (dev server / packaged page) fetch()es this scheme cross-origin, and
// Chromium refuses non-CORS-enabled schemes before the handler even runs.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "tuxbooks",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

/**
 * Mirror of the sidecar's database-path resolution (TEST_* overrides first,
 * then the XDG data home). The covers directory sits next to the database.
 */
function coversDir(): string {
  const override = process.env.TEST_DATABASE_PATH;
  const dbPath =
    override && override.length > 0
      ? override
      : path.join(
          process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.length > 0
            ? process.env.XDG_DATA_HOME
            : path.join(app.getPath("home"), ".local/share"),
          "com.tuxbooks.app",
          "tuxbooks.db",
        );
  return path.join(path.dirname(dbPath), "covers");
}

function bookMime(format: string | null): string {
  if (format === "epub") return "application/epub+zip";
  if (format === "pdf") return "application/pdf";
  return "application/octet-stream";
}

const COVER_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function coverMime(filePath: string): string {
  return (
    COVER_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"
  );
}

/** Parse a single `bytes=start-end` range header (open ends allowed). */
function parseRange(header: string | null): { start?: number; end?: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;
  return {
    start: rawStart === "" ? undefined : Number(rawStart),
    end: rawEnd === "" ? undefined : Number(rawEnd),
  };
}

function registerProtocol(sidecar: Sidecar): void {
  const covers = coversDir();
  const debug = process.env.TUXBOOKS_DEBUG_IPC === "1";
  protocol.handle("tuxbooks", async (request) => {
    const url = new URL(request.url);
    if (debug) console.log(`[tuxbooks://] ${request.method} ${request.url}`);

    // The renderer origin (dev server / app:// page) is cross-origin to this
    // scheme; without CORS the renderer fetch() fails before the handler
    // response is usable. The scheme serves only this app's own resources.
    const cors = { "access-control-allow-origin": "*" };

    // tuxbooks://book/<id>?format=epub|pdf — a stored book's source bytes
    // (Range-capable: the reader engines seek into large documents).
    if (url.host === "book") {
      const bookId = Number.parseInt(url.pathname.slice(1), 10);
      if (!Number.isInteger(bookId) || bookId <= 0) {
        return new Response("invalid book id", { status: 400 });
      }
      const range = parseRange(request.headers.get("range"));
      try {
        if (range && range.start !== undefined) {
          const end = range.end ?? Number.MAX_SAFE_INTEGER;
          if (end < range.start) {
            return new Response("invalid range", { status: 416 });
          }
          const result = (await sidecar.call("get_book_bytes", {
            bookId,
            offset: range.start,
            length: end - range.start + 1,
          })) as { data: string; offset: number; total: number };
          if (range.start >= result.total) {
            return new Response("range not satisfiable", {
              status: 416,
              headers: { "content-range": `bytes */${result.total}`, ...cors },
            });
          }
          const bytes = Buffer.from(result.data, "base64");
          return new Response(bytes, {
            status: 206,
            headers: {
              "content-type": bookMime(url.searchParams.get("format")),
              "content-length": String(bytes.length),
              "content-range": `bytes ${result.offset}-${result.offset + bytes.length - 1}/${result.total}`,
              "accept-ranges": "bytes",
              ...cors,
            },
          });
        }
        const result = (await sidecar.call("get_book_bytes", { bookId })) as {
          data: string;
          total: number;
        };
        const bytes = Buffer.from(result.data, "base64");
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": bookMime(url.searchParams.get("format")),
            "content-length": String(bytes.length),
            "accept-ranges": "bytes",
            ...cors,
          },
        });
      } catch (error) {
        if (error instanceof RpcFailure) {
          return new Response(error.message, { status: 404, headers: cors });
        }
        console.error("[tuxbooks://book] failed:", error);
        return new Response("internal error", { status: 500, headers: cors });
      }
    }

    // tuxbooks://cover/<url-encoded absolute path> — extracted cover art.
    // The path must resolve inside the covers directory (no traversal).
    if (url.host === "cover") {
      const requested = decodeURIComponent(url.pathname.slice(1));
      const resolved = path.resolve(requested);
      if (resolved !== covers && !resolved.startsWith(covers + path.sep)) {
        return new Response("forbidden", { status: 403 });
      }
      try {
        const bytes = await fsp.readFile(resolved);
        return new Response(bytes, {
          status: 200,
          headers: {
            "content-type": coverMime(resolved),
            "content-length": String(bytes.length),
            ...cors,
          },
        });
      } catch {
        return new Response("not found", { status: 404 });
      }
    }

    return new Response("not found", { status: 404 });
  });
}

interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

const DEFAULT_STATE: WindowState = { width: 1100, height: 720, maximized: false };

function windowStateFile(): string {
  return path.join(app.getPath("userData"), "window-state.json");
}

function loadWindowState(): WindowState {
  try {
    const state = JSON.parse(fs.readFileSync(windowStateFile(), "utf8")) as WindowState;
    if (typeof state.width === "number" && typeof state.height === "number") {
      return state;
    }
  } catch {
    // Missing or corrupt state falls back to defaults.
  }
  return { ...DEFAULT_STATE };
}

function saveWindowState(window: BrowserWindow): void {
  const state: WindowState = {
    ...window.getBounds(),
    maximized: window.isMaximized(),
  };
  try {
    fs.writeFileSync(windowStateFile(), JSON.stringify(state));
  } catch (error) {
    console.error("failed to save window state:", error);
  }
}

function createWindow(
  sidecar: Sidecar,
  forward: (name: string, payload: unknown) => void,
): BrowserWindow {
  const state = loadWindowState();
  const window = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    title: "tuxbooks",
    show: false,
    backgroundColor: "#0b0b0f",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  window.once("ready-to-show", () => {
    if (state.maximized) window.maximize();
    else window.show();
  });

  // Window size/position survive restarts (formerly the window-state plugin).
  const persist = (): void => saveWindowState(window);
  window.on("close", persist);
  window.on("maximize", persist);
  window.on("unmaximize", persist);

  // In-page links never spawn extra Chromium windows; http(s) links go to
  // the system browser, everything else is dropped.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== DEV_SERVER_URL && !url.startsWith("file://")) {
      event.preventDefault();
      if (url.startsWith("http://") || url.startsWith("https://")) {
        void shell.openExternal(url);
      }
    }
  });

  // Dev server only when explicitly requested (just dev); everything else —
  // packaged builds and the E2E runs — loads the built renderer from disk.
  if (process.env.VITE_DEV_SERVER_URL !== undefined) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void window.loadFile(path.join(__dirname, "../../frontend/dist/index.html"));
  }

  // Dev boot check: the renderer must mount the app shell, or a broken
  // bridge/preload fails loudly here instead of silently showing a blank
  // window (xvfb/CI runs have no human to notice). TUXBOOKS_BOOT_PROBE=1
  // additionally fetches one book through the tuxbooks:// protocol and
  // logs the byte count (protocol + sidecar byte path end-to-end).
  window.webContents.on("did-finish-load", () => {
    if (app.isPackaged && process.env.VITE_DEV_SERVER_URL === undefined) return;
    const probe =
      process.env.TUXBOOKS_BOOT_PROBE === "1"
        ? `Promise.all([
              fetch("tuxbooks://book/1")
                .then((r) => r.arrayBuffer().then((b) => "fetch-book:" + r.status + ":" + b.byteLength))
                .catch((e) => "fetch-book failed: " + e.message),
              fetch("tuxbooks://cover/x")
                .then((r) => "fetch-cover:" + r.status)
                .catch((e) => "fetch-cover failed: " + e.message),
              new Promise((resolve) => {
                const img = new Image();
                img.onload = () => resolve("img-book:loaded " + img.naturalWidth);
                img.onerror = () => resolve("img-book:error");
                img.src = "tuxbooks://book/1";
              }),
            ]).then((results) => results.join(" | "))`
        : "null";
    void window.webContents
      .executeJavaScript(
        `(() => {
          const state = {
            mounted: Boolean(document.querySelector('[data-testid="app-shell"]')),
            rootChildren: document.getElementById("root")?.children.length ?? 0,
          };
          const probePromise = ${probe};
          return probePromise
            ? probePromise.then((probe) => ({ ...state, probe }))
            : state;
        })()`,
      )
      .then((state: { mounted: boolean; rootChildren: number; probe?: string }) => {
        if (!state.mounted) {
          console.error(`[boot] app shell did not mount (root children: ${state.rootChildren})`);
          return;
        }
        console.log("[boot] renderer mounted");
        if (state.probe !== undefined) {
          console.log(`[boot] tuxbooks://book/1 -> ${state.probe}`);
        }
      })
      .catch((error: unknown) => console.error("[boot] check failed:", error));
  });

  void sidecar.start().catch((error) => {
    console.error("[sidecar] initial start failed:", error);
  });

  return window;
}

function registerIpc(sidecar: Sidecar, debugLog: (line: string) => void): void {
  const debugIpc = process.env.TUXBOOKS_DEBUG_IPC === "1";
  ipcMain.handle("tuxbooks:invoke", async (_event, method: unknown, params: unknown) => {
    if (typeof method !== "string" || !SIDECAR_METHODS.has(method)) {
      throw new SidecarError(`method not allowed: ${String(method)}`);
    }
    if (params === null || typeof params !== "object" || Array.isArray(params)) {
      throw new SidecarError("params must be an object");
    }
    if (debugIpc) {
      debugLog?.(`ipc ${method}`);
      console.log(`[ipc] ${method}`);
    }
    return sidecar.call(method, params as Record<string, unknown>);
  });

  ipcMain.handle("tuxbooks:dialog", async (_event, kind: unknown) => {
    if (kind === "directory") {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        title: "Choose a folder to import",
      });
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    }
    if (kind === "book-file") {
      const result = await dialog.showOpenDialog({
        properties: ["openFile"],
        title: "Locate the book file",
        filters: [{ name: "Ebooks", extensions: ["epub", "pdf"] }],
      });
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    }
    if (kind === "book-files") {
      const result = await dialog.showOpenDialog({
        properties: ["openFile", "multiSelections"],
        title: "Choose book files to import",
        filters: [{ name: "Ebooks", extensions: ["epub", "pdf"] }],
      });
      return result.canceled ? [] : result.filePaths;
    }
    if (kind === "cover-image") {
      const result = await dialog.showOpenDialog({
        properties: ["openFile"],
        title: "Choose a cover image",
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
      });
      return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    }
    throw new SidecarError(`unknown dialog kind: ${String(kind)}`);
  });

  ipcMain.handle("tuxbooks:reveal", (_event, target: unknown) => {
    if (typeof target !== "string" || target.length === 0) {
      throw new SidecarError("reveal requires a path");
    }
    shell.showItemInFolder(target);
  });
}

app.whenReady().then(() => {
  // TUXBOOKS_DEBUG_IPC=1 appends bridge/protocol/event traces to the
  // per-run userData dir — chromedriver swallows process stdout, so E2E
  // diagnosis needs this on disk (artifacts keep the scratch config).
  const debugLogPath =
    process.env.TUXBOOKS_DEBUG_IPC === "1" && process.env.E2E_RUN_ID
      ? `/tmp/tuxbooks-main-debug-${process.env.E2E_RUN_ID}.log`
      : null;
  const debugLog = (line: string): void => {
    if (!debugLogPath) return;
    try {
      fs.appendFileSync(debugLogPath, `${new Date().toISOString()} [pid ${process.pid}] ${line}\n`);
    } catch {
      // Diagnostics only.
    }
  };

  // Sidecar events (library changes, import progress) reach the renderer
  // through the one channel the preload listens on.
  const forward = (name: string, payload: unknown): void => {
    const windows = BrowserWindow.getAllWindows();
    debugLog(`forward ${name} windows=${windows.length}`);
    for (const window of windows) {
      window.webContents.send("tuxbooks:event", name, payload);
    }
  };
  const sidecar = new Sidecar(locateSidecar(process.resourcesPath), forward);
  registerProtocol(sidecar);
  registerIpc(sidecar, debugLog);
  // The window opens only after the sidecar is healthy: the renderer's very
  // first invokes assume the method table is live, and the service registers
  // its filesystem watchers during startup — a UI that outruns the sidecar
  // races those registrations (a file added in that window is never picked
  // up until an unrelated event). The Tauri shell guaranteed this ordering;
  // keep it.
  debugLog("app starting sidecar");
  sidecar
    .start()
    .then(() => {
      debugLog("sidecar healthy; creating window");
      createWindow(sidecar, forward);
    })
    .catch((error) => {
      console.error("[sidecar] startup failed:", error);
      app.quit();
    });

  app.on("before-quit", () => sidecar.stop());
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
