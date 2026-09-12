import { protocol, app, BrowserWindow, Menu, nativeImage, ipcMain, dialog, shell } from "electron";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { locateSidecar, RpcFailure, Sidecar, SidecarError } from "./sidecar";
import { clearGpuFallbackMarker, readGpuFallbackMarker, recordGpuCrashes } from "./gpuFallback";

/**
 * Electron main process (docs/ARCHITECTURE.md): window lifecycle, native
 * dialogs/shell, the scoped `tuxbooks://` resource protocol, and the Rust
 * sidecar. Plumbing only — no business logic.
 */

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:1420";

// Startup segment timing (dev diagnosis): where the boot latency sits —
// Electron init, sidecar readiness, or the renderer's first mount.
// performance.now() is monotonic with the process start, so every segment
// reads against one origin; never wall-clock differences.
const BOOT_START = performance.now();
const bootElapsed = (label: string): void => {
  console.log(`[startup] ${label} +${Math.round(performance.now() - BOOT_START)}ms`);
};
// Anchor segment: bundle evaluation itself (module graph + protocol setup).
// The gap between this and "app ready" is Chromium's platform init (GPU,
// compositor, fontconfig, high-DPI) on the developer machine (PERF-11:
// measure, never work around unmeasured).
bootElapsed("electron process");

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
  "get_epub_session",
  "get_book_resource",
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

/**
 * GPU-crash fallback (docs/gpu-fallback.md, issue #13): a session that lost
 * its GPU process repeatedly leaves a marker; the next launch then runs
 * software-rendered until a stable session clears the marker again. Must be
 * decided here, before app ready (disableHardwareAcceleration is legal only
 * in this window). Chromium recovers a crashed GPU process itself — this is
 * the next-launch degradation, never an in-session action.
 */
const GPU_FALLBACK_DIR = appDataDir();
const activeGpuFallback = readGpuFallbackMarker(GPU_FALLBACK_DIR);
if (activeGpuFallback) {
  app.disableHardwareAcceleration();
  console.warn(
    `[gpu-fallback] hardware acceleration disabled for this launch:` +
      ` ${activeGpuFallback.crashes} GPU-process crashes recorded` +
      ` (last ${activeGpuFallback.lastCrashAt}, expires ${activeGpuFallback.expiresAt};` +
      ` docs/gpu-fallback.md)`,
  );
}
// GPU-process crashes ("crashed", not the benign cleanExit/killed) seen in
// this session; drives both the threshold check and the will-quit self-heal.
let gpuCrashCount = 0;

// No application menu: the renderer owns every interaction, and the
// Electron default bar (File/Edit/View/Window — reload, devtools, close
// accelerators) has no place in a shipped desktop app. Removes the bar
// from every window before any exists.
Menu.setApplicationMenu(null);

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
  {
    // The built renderer's own origin. A standard, secure scheme — not
    // file:// — because opaque file origins leak into blob: child frames
    // (the reader engines' sandboxed section documents), whose postMessage
    // then fails with "Invalid target origin 'null'". app:// keeps the page
    // and its blob frames same-origin.
    scheme: "app",
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
 * then the XDG data home). The covers directory and the GPU-fallback marker
 * (docs/gpu-fallback.md) sit next to the database.
 */
function appDataDir(): string {
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
  return path.dirname(dbPath);
}

function coversDir(): string {
  return path.join(appDataDir(), "covers");
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

/** Root of the built renderer bundle, served as `app://bundle/...`. */
const APP_ORIGIN = "app://bundle";

function rendererDistDir(): string {
  return path.join(__dirname, "../../frontend/dist");
}

const APP_MIME_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".txt": "text/plain",
};

/**
 * Serve the built renderer over the `app` scheme: `app://bundle/<path>`
 * maps onto the dist directory, unknown paths fall back to index.html (the
 * renderer is a single page). Registered next to `tuxbooks://` in main.
 */
function registerAppProtocol(): void {
  const dist = rendererDistDir();
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    if (url.host !== "bundle") {
      return new Response("not found", { status: 404 });
    }
    const relative = decodeURIComponent(url.pathname.slice(1));
    const resolved = path.resolve(dist, relative);
    let filePath = resolved;
    if (relative === "" || (!resolved.startsWith(dist + path.sep) && resolved !== dist)) {
      filePath = path.join(dist, "index.html");
    } else if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      // SPA fallback: the renderer owns its routing state-side.
      filePath = path.join(dist, "index.html");
    }
    const mime =
      APP_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
    const body = fs.readFileSync(filePath);
    return new Response(body, {
      status: 200,
      headers: { "content-type": mime, "content-length": String(body.length) },
    });
  });
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
    // tuxbooks://book/<id>/<encoded member path> — one EPUB ZIP member
    // (chapter document, image, stylesheet, font) for the Readium
    // navigator, which resolves sub-resources against the publication base
    // URL. The member path is percent-encoded exactly like the manifest's
    // hrefs; it is decoded once here before the sidecar lookup.
    if (url.host === "book") {
      const rest = url.pathname.slice(1);
      const slash = rest.indexOf("/");
      const bookId = Number.parseInt(slash === -1 ? rest : rest.slice(0, slash), 10);
      if (!Number.isInteger(bookId) || bookId <= 0) {
        return new Response("invalid book id", { status: 400 });
      }
      if (slash === -1) {
        return serveBookBytes(url, sidecar, bookId, request);
      }
      return serveBookResource(sidecar, bookId, decodeURIComponent(rest.slice(slash + 1)), request);
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

/** `tuxbooks://book/<id>` — a stored book's whole source file (Range-capable). */
async function serveBookBytes(
  url: URL,
  sidecar: Sidecar,
  bookId: number,
  request: Request,
): Promise<Response> {
  const cors = { "access-control-allow-origin": "*" };
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

/**
 * `tuxbooks://book/<id>/<member>` — one EPUB ZIP member, decoded and
 * extracted by the sidecar. Ranges slice the decoded member (member entries
 * decompress whole); 404 maps from a failed lookup, 416 from a bad range.
 */
async function serveBookResource(
  sidecar: Sidecar,
  bookId: number,
  member: string,
  request: Request,
): Promise<Response> {
  const cors = { "access-control-allow-origin": "*" };
  if (member.length === 0) {
    return new Response("missing resource path", { status: 400 });
  }
  const range = parseRange(request.headers.get("range"));
  if (range && range.start !== undefined && range.end !== undefined && range.end < range.start) {
    return new Response("invalid range", { status: 416 });
  }
  try {
    const result = (await sidecar.call("get_book_resource", {
      bookId,
      path: member,
      offset: range?.start,
      length:
        range?.start !== undefined
          ? (range.end ?? Number.MAX_SAFE_INTEGER) - range.start + 1
          : undefined,
    })) as { data: string; offset: number; total: number; mediaType: string };
    if (range?.start !== undefined && range.start >= result.total) {
      return new Response("range not satisfiable", {
        status: 416,
        headers: { "content-range": `bytes */${result.total}`, ...cors },
      });
    }
    const bytes = Buffer.from(result.data, "base64");
    const headers: Record<string, string> = {
      "content-type": result.mediaType,
      "content-length": String(bytes.length),
      "accept-ranges": "bytes",
      ...cors,
    };
    if (range?.start !== undefined) {
      headers["content-range"] =
        `bytes ${result.offset}-${result.offset + bytes.length - 1}/${result.total}`;
    }
    return new Response(bytes, { status: range?.start !== undefined ? 206 : 200, headers });
  } catch (error) {
    if (error instanceof RpcFailure) {
      return new Response(error.message, { status: 404, headers: cors });
    }
    console.error("[tuxbooks://book] resource failed:", error);
    return new Response("internal error", { status: 500, headers: cors });
  }
}

/**
 * Deterministic startup geometry (docs/fix-electron-main-window-behaviour.md
 * §6): every launch is a centered, unmaximized, useful-size window. Nothing
 * about the window is persisted between runs, so a maximized session can
 * never leak into the next startup.
 */
const WINDOW_DEFAULTS = {
  width: 1280,
  height: 820,
  minWidth: 900,
  minHeight: 600,
} as const;

/**
 * The native window/taskbar icon (docs/fix-electron-main-window-behaviour.md
 * §13). `build/icons/` is the canonical source; dev and E2E resolve it from
 * the repo layout next to the electron bundle, packaged builds get it
 * copied to resources/icons by electron-builder's extraResources (the asar
 * itself carries only electron/dist + frontend/dist). The icon is decoded
 * here rather than passed as a path: a string path can silently fail to
 * load on Linux and leave the window iconless, so decode + isEmpty-guard.
 */
function appIcon(): Electron.NativeImage | undefined {
  const candidates = ["512x512.png", "256x256.png", "128x128.png"].flatMap((size) => [
    path.join(__dirname, "../../build/icons", size),
    path.join(process.resourcesPath, "icons", size),
  ]);
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) return image;
  }
  return undefined;
}

function createWindow(forward: (name: string, payload: unknown) => void): BrowserWindow {
  const window = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    center: true,
    title: "TuxBooks",
    resizable: true,
    maximizable: true,
    minimizable: true,
    icon: appIcon(),
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

  window.webContents.on("did-finish-load", () => bootElapsed("renderer did-finish-load"));
  window.webContents.on("render-process-gone", (_event, details) => logRenderProcessGone(details));

  // Dev-only DevTools access (the dev server runs only via `just dev`):
  // with the application menu gone, the stock Ctrl+Shift+I accelerator no
  // longer exists, so the toggle keys are intercepted before the page sees
  // them. Everything else passes through untouched.
  if (process.env.VITE_DEV_SERVER_URL !== undefined) {
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      const key = input.key.toLowerCase();
      const devtoolsToggle = key === "f12" || (input.control && input.shift && key === "i");
      if (!devtoolsToggle) return;
      event.preventDefault();
      if (window.webContents.isDevToolsOpened()) {
        window.webContents.closeDevTools();
      } else {
        window.webContents.openDevTools();
      }
    });
  }
  window.once("ready-to-show", () => {
    bootElapsed("ready-to-show");
    window.show();
    bootElapsed("window shown");
  });

  // In-page links never spawn extra Chromium windows; http(s) links go to
  // the system browser, everything else is dropped.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    const built = url === `${APP_ORIGIN}/index.html` || url.startsWith(`${APP_ORIGIN}/assets/`);
    if (url !== DEV_SERVER_URL && !built && !url.startsWith("file://")) {
      event.preventDefault();
      if (url.startsWith("http://") || url.startsWith("https://")) {
        void shell.openExternal(url);
      }
    }
  });

  // Dev server only when explicitly requested (just dev); everything else —
  // packaged builds and the E2E runs — loads the built renderer from disk
  // through the app:// scheme (a real origin; see registerAppProtocol).
  bootElapsed("browser window created");
  // Loader lifecycle segments (§11): did-finish-load → ready-to-show hides
  // the first-paint gap on Linux/Wayland; these labels split loadURL into
  // did-start-loading, dom-ready, did-finish-load, ready-to-show so the
  // slow segment is identified, not guessed.
  window.webContents.on("did-start-loading", () => bootElapsed("renderer did-start-loading"));
  window.webContents.on("dom-ready", () => bootElapsed("renderer dom-ready"));
  if (process.env.VITE_DEV_SERVER_URL !== undefined) {
    bootElapsed("renderer load started");
    void window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    bootElapsed("renderer load started");
    void window.loadURL(`${APP_ORIGIN}/index.html`);
  }

  // Dev boot check: the renderer must mount the app shell, or a broken
  // bridge/preload fails loudly here instead of silently showing a blank
  // window (xvfb/CI runs have no human to notice). TUXBOOKS_BOOT_PROBE=1
  // additionally fetches one book through the tuxbooks:// protocol and
  // logs the byte count (protocol + sidecar byte path end-to-end).
  window.webContents.on("did-finish-load", () => {
    // Packaged runs skip the check except when TUXBOOKS_BOOT_PROBE=1 opts
    // in: the probe doubles as the packaged-build smoke test (an asar/path
    // regression would fail here before any human notices).
    if (
      app.isPackaged &&
      process.env.TUXBOOKS_BOOT_PROBE !== "1" &&
      process.env.VITE_DEV_SERVER_URL === undefined
    ) {
      return;
    }
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
        bootElapsed("renderer mounted");
        if (state.probe !== undefined) {
          console.log(`[boot] tuxbooks://book/1 -> ${state.probe}`);
        }
      })
      .catch((error: unknown) => console.error("[boot] check failed:", error));
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
  bootElapsed("app ready");
  // TUXBOOKS_DEBUG_IPC=1 appends bridge/protocol/event traces to a
  // per-run file, so E2E diagnosis works from CI artifacts alone.
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
  registerAppProtocol();
  registerProtocol(sidecar);
  registerIpc(sidecar, debugLog);
  // The window opens only after the sidecar is healthy: the renderer's very
  // first invokes assume the method table is live, and the service registers
  // its filesystem watchers during startup — a UI that outruns the sidecar
  // races those registrations (a file added in that window is never picked
  // up until an unrelated event). The Tauri shell guaranteed this ordering;
  // keep it.
  bootElapsed("sidecar start");
  debugLog("app starting sidecar");
  sidecar
    .start()
    .then(() => {
      bootElapsed("sidecar healthy");
      debugLog("sidecar healthy; creating window");
      createWindow(forward);
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

/**
 * Self-heal (docs/gpu-fallback.md): a hardware-accelerated session that ends
 * cleanly without a single GPU crash proves the graphics stack works — clear
 * the fallback marker so the next launch tries hardware again. A
 * software-rendered session (fallback active) cannot prove anything about
 * the hardware path and never clears the marker; a session with GPU crashes
 * keeps it. Also removes stale/expired markers.
 */
app.on("will-quit", () => {
  if (activeGpuFallback || gpuCrashCount > 0) return;
  if (clearGpuFallbackMarker(GPU_FALLBACK_DIR)) {
    console.log("[gpu-fallback] stable hardware-accelerated session; fallback cleared");
  }
});

/**
 * Process-failure diagnostics (§ GPU/renderer gone): GPU and renderer
 * process deaths are logged with Electron's own classification — type,
 * reason, exit code — plus the environment needed to correlate a crash
 * (versions, GPU feature status). Diagnostics only: a GPU-process exit is
 * recovered by Chromium itself; never reload() from these events.
 *
 * The one policy exception (docs/gpu-fallback.md): repeated GPU crashes in
 * a hardware-accelerated session arm the next-launch software-rendering
 * fallback. No in-session action is possible (or needed) — Chromium already
 * restarted the process.
 */
app.on("child-process-gone", (_event, details) => {
  if (details.type !== "GPU") return;
  if (details.reason === "crashed") gpuCrashCount += 1;
  console.error(
    `[electron] GPU process gone: reason=${details.reason} exitCode=${details.exitCode}` +
      ` name=${details.name ?? "n/a"} serviceName=${details.serviceName ?? "n/a"}` +
      ` crashesThisSession=${gpuCrashCount}` +
      ` electron=${process.versions.electron} chromium=${process.versions.chrome}` +
      ` gpu=${JSON.stringify(app.getGPUFeatureStatus())}`,
  );
  if (!activeGpuFallback && details.reason === "crashed") {
    const marker = recordGpuCrashes(GPU_FALLBACK_DIR, gpuCrashCount, {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
    });
    if (marker) {
      console.warn(
        `[gpu-fallback] repeated GPU-process crashes (${gpuCrashCount});` +
          ` the next launch runs software-rendered (docs/gpu-fallback.md)`,
      );
    }
  }
});

// Renderer deaths are fatal to the page but distinct from GPU failures;
// Electron restarts nothing here, so the log must carry the failure mode.
function logRenderProcessGone(details: Electron.RenderProcessGoneDetails): void {
  console.error(
    `[electron] renderer gone: reason=${details.reason} exitCode=${details.exitCode}` +
      ` electron=${process.versions.electron} chromium=${process.versions.chrome}`,
  );
}
