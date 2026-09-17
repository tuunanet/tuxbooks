import {
  protocol,
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  ipcMain,
  dialog,
  session,
  shell,
} from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { locateSidecar, Sidecar } from "./sidecar";
import { clearGpuFallbackMarker, readGpuFallbackMarker, recordGpuCrashes } from "./gpuFallback";
import { handleProtocolRequest } from "./protocolHandler";
import { makeProtocolSources } from "./protocolSources";
import { IssuedPaths } from "./ipcPolicy";
import { registerIpcHandlers } from "./ipcHandlers";
import {
  assertRendererIsolation,
  isAllowedAppNavigation,
  isPermissionAllowed,
  originOfRequestUrl,
  RENDERER_ISOLATION,
} from "./windowSecurity";
import { APP_UI_CSP } from "../shared/appCsp";
import { parseExternalHttpUrl } from "../shared/linkPolicy";
import { APP_ORIGIN, PRIVILEGED_SCHEMES } from "../shared/pathSchema";

/**
 * Electron main process (docs/ARCHITECTURE.md): window lifecycle, native
 * dialogs/shell, the scoped `tuxbooks://` resource protocol, and the Rust
 * sidecar. Plumbing only — no business logic.
 */

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
// The table (docs/ARCHITECTURE.md) declares exactly these two schemes.
protocol.registerSchemesAsPrivileged([...PRIVILEGED_SCHEMES]);

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

/**
 * X-5 (issue #85): the only path to shell.openExternal. The raw string
 * never reaches shell, only parseExternalHttpUrl's canonical http(s)
 * output does; everything else is dropped.
 */
function openExternalIfValid(raw: string): void {
  const validated = parseExternalHttpUrl(raw);
  if (validated !== null) void shell.openExternal(validated);
}

/** Root of the built renderer bundle, served as `app://bundle/...`. */

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
 * renderer is a single page). Registered next to `tuxbooks://` in main;
 * every malformed URL fails closed to 404.
 */
function registerAppProtocol(): void {
  const dist = rendererDistDir();
  protocol.handle("app", (request) => {
    try {
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
        headers: {
          "content-type": mime,
          "content-length": String(body.length),
          // X-2: the app UI's CSP rides on every app:// response (issue #85).
          "content-security-policy": APP_UI_CSP,
        },
      });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
}

function registerProtocol(sidecar: Sidecar): void {
  const sources = makeProtocolSources(sidecar, coversDir());
  protocol.handle("tuxbooks", (request) => {
    if (process.env.TUXBOOKS_DEBUG_IPC === "1") {
      console.log(`[tuxbooks://] ${request.method} ${request.url}`);
    }
    return handleProtocolRequest(request, sources);
  });
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
  // X-1 (issue #85): the four isolation flags are explicit, and the
  // assertion fails startup loudly when one drifts instead of shipping a
  // softer renderer.
  const webPreferences: Electron.WebPreferences = {
    preload: path.join(__dirname, "preload.cjs"),
    ...RENDERER_ISOLATION,
  };
  assertRendererIsolation(webPreferences);
  const window = new BrowserWindow({
    ...WINDOW_DEFAULTS,
    center: true,
    title: "TuxBooks",
    resizable: true,
    maximizable: true,
    minimizable: true,
    icon: appIcon(),
    show: false,
    // Light background matching the :root token in frontend/src/index.css;
    // the renderer's inline theme bootstrap paints the real choice before
    // first content paint.
    backgroundColor: "#ffffff",
    webPreferences,
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

  // In-page links never spawn extra Chromium windows. X-5 (issue #85):
  // every target goes through the validated link seam first, only
  // canonical http(s) URLs reach the system browser, everything else is
  // dropped. X-3: the top frame navigates only inside the app origin (or
  // the dev server while one is actually configured); anything else,
  // file://, the resource protocol, data:, other origins, is prevented,
  // and validated http(s) targets go to the system browser instead.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfValid(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url, process.env.VITE_DEV_SERVER_URL)) return;
    event.preventDefault();
    openExternalIfValid(url);
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
  // Paths handed to the renderer through native dialogs; filesystem-acting
  // IPC calls accept only these back (docs/ARCHITECTURE.md, issue #84).
  // The handlers themselves (with the per-channel sender gate) live in
  // ipcHandlers.ts, unit-tested without Electron.
  registerIpcHandlers(
    (channel, handler) => {
      ipcMain.handle(channel, (event, ...args) => handler(event, ...args));
    },
    {
      sidecar,
      issued: new IssuedPaths(),
      dialog,
      shell,
      debugIpc: process.env.TUXBOOKS_DEBUG_IPC === "1",
      debugLog,
    },
  );
}

app.whenReady().then(() => {
  bootElapsed("app ready");
  // TUXBOOKS_DEBUG_IPC=1 appends bridge/protocol/event traces to a
  // per-run file, so E2E diagnosis works from CI artifacts alone. The file
  // lives in its own mkdtemp'd directory (0700, unpredictable name) — a
  // fixed path in the shared temp dir is a symlink target on multi-user
  // machines (same class as the sidecar's debug log).
  const debugLogPath =
    process.env.TUXBOOKS_DEBUG_IPC === "1" && process.env.E2E_RUN_ID
      ? path.join(
          fs.mkdtempSync(path.join(os.tmpdir(), `tuxbooks-main-debug-${process.env.E2E_RUN_ID}-`)),
          "main-debug.log",
        )
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
      // A window closing, a reload disposing the old frame, or app quit
      // racing sidecar output can dispose the render frame between the
      // window lookup and the send — Electron then throws "Render frame
      // was disposed before WebFrameMain could be accessed". The event is
      // transient UI state with no renderer left to receive it; dropping
      // it (and the destroy checks narrow the race without eliminating
      // it, hence the catch) is the correct behavior. The sidecar keeps
      // running and the next event reaches the next live frame.
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        window.webContents.send("tuxbooks:event", name, payload);
      } catch {
        // Frame died mid-send; nothing to deliver to.
      }
    }
  };
  // X-4 (issue #85): permissions are denied by default. The single grant
  // is fullscreen from the application's own origin, the reader's
  // presentation mode (ReaderShell). Both handlers share the one policy
  // function so requests and checks can never disagree.
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      callback(
        isPermissionAllowed(permission, originOfRequestUrl(details.requestingUrl), devServerUrl),
      );
    },
  );
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return isPermissionAllowed(permission, requestingOrigin, devServerUrl);
  });

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
