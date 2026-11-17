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
  clipboard,
} from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { locateSidecar, Sidecar } from "./sidecar";
import { clearGpuFallbackMarker, readGpuFallbackMarker, recordGpuCrashes } from "./gpuFallback";
import { recordRendererConsole, replayRendererConsoleTail } from "./rendererConsole";
import { reportStartupFailure, surfaceStartupQuarantine } from "./bootRecovery";
import { runCli } from "./cli";
import { runDryRun, runResetData, type ResetDataDeps } from "./resetData";
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

const BOOT_START = performance.now();
const bootElapsed = (label: string): void => {
  console.log(`[startup] ${label} +${Math.round(performance.now() - BOOT_START)}ms`);
};

const stdout = (message: string): void => console.log(message);
const stderr = (message: string): void => console.error(message);

/** Built per call so a plain GUI launch never resolves storage dirs. */
const resetDeps = (): ResetDataDeps => ({
  fs,
  dirs: appStorageDirs(),
  stdout,
  stderr,
});

// CLI commands run before the startup log, app ready, and the single-instance lock.
const cliHandled = runCli(process.argv, {
  stdout,
  stderr,
  exit: (code) => app.exit(code),
  version: app.getVersion(),
  runDryRun: () => runDryRun(resetDeps()),
  runResetData: () => runResetData(resetDeps()),
  forwardSwitch: (name, value) => app.commandLine.appendSwitch(name, value ?? ""),
});

if (!cliHandled) bootElapsed("electron process");

// A second instance would spawn a sidecar on the first's database and open a window that never loads.
// quit() only schedules the exit; exit now via fs.writeSync, which survives it.
if (!cliHandled && !app.requestSingleInstanceLock()) {
  try {
    fs.writeSync(
      2,
      `[startup] another TuxBooks instance already owns this profile (${app.getPath("userData")}); exiting\n`,
    );
  } catch {}
  app.exit(0);
}

/**
 * GPU-crash fallback (issue #13): a session that lost
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
      ` (last ${activeGpuFallback.lastCrashAt}, expires ${activeGpuFallback.expiresAt})`,
  );
}
let gpuCrashCount = 0;

Menu.setApplicationMenu(null);

// Registered before app ready; corsEnabled matters because the renderer fetches this scheme cross-origin.
protocol.registerSchemesAsPrivileged([...PRIVILEGED_SCHEMES]);

/**
 * Mirror of the sidecar's database-path resolution (TEST_* overrides first,
 * then the XDG data home). The covers directory and the GPU-fallback marker
 * sit next to the database.
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
 * The two app-owned storage roots, resolved once per call: the data root from
 * main's resolver, the config root from Electron at runtime (the packaged
 * directory name is uncertain, so it is never hardcoded).
 */
function appStorageDirs(): { dataDir: string; configDir: string } {
  return { dataDir: appDataDir(), configDir: app.getPath("userData") };
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

/** CJS bundle: __dirname is electron/dist; asset paths below resolve from it. */
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
          // X-2: the app UI's CSP rides on every app:// response.
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
 * Deterministic startup geometry: every launch is a centered, unmaximized,
 * useful-size window. Nothing
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
 * The native window/taskbar icon. `build/icons/` is the canonical source; dev and E2E resolve it from
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
  // X-1: isolation flags are explicit; the assertion fails startup if one drifts.
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
    backgroundColor: "#ffffff",
    webPreferences,
  });

  window.webContents.on("did-finish-load", () => bootElapsed("renderer did-finish-load"));
  window.webContents.on("console-message", (details) => recordRendererConsole(details));
  window.webContents.on("render-process-gone", (_event, details) => logRenderProcessGone(details));

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

  // X-5/X-3: only canonical http(s) reach the browser; the top frame stays on the app origin.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfValid(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isAllowedAppNavigation(url, process.env.VITE_DEV_SERVER_URL)) return;
    event.preventDefault();
    openExternalIfValid(url);
  });

  bootElapsed("browser window created");
  window.webContents.on("did-start-loading", () => bootElapsed("renderer did-start-loading"));
  window.webContents.on("dom-ready", () => bootElapsed("renderer dom-ready"));
  if (process.env.VITE_DEV_SERVER_URL !== undefined) {
    bootElapsed("renderer load started");
    void window.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    bootElapsed("renderer load started");
    void window.loadURL(`${APP_ORIGIN}/index.html`);
  }

  window.webContents.on("did-finish-load", () => {
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
  // Filesystem-acting IPC accepts back only paths issued through native dialogs (issue #84).
  registerIpcHandlers(
    (channel, handler) => {
      ipcMain.handle(channel, (event, ...args) => handler(event, ...args));
    },
    {
      sidecar,
      issued: new IssuedPaths(),
      dialog,
      shell,
      clipboard,
      storageDirs: appStorageDirs(),
      debugIpc: process.env.TUXBOOKS_DEBUG_IPC === "1",
      debugLog,
    },
  );
}

app.whenReady().then(() => {
  if (cliHandled) return;
  bootElapsed("app ready");
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
    } catch {}
  };

  const forward = (name: string, payload: unknown): void => {
    const windows = BrowserWindow.getAllWindows();
    debugLog(`forward ${name} windows=${windows.length}`);
    for (const window of windows) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        window.webContents.send("tuxbooks:event", name, payload);
      } catch {}
    }
  };
  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  // X-4: permissions are denied by default; only fullscreen from the app origin is granted.
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
  bootElapsed("sidecar start");
  debugLog("app starting sidecar");
  // The window opens only after the sidecar is healthy: first invokes assume its method table is live.
  sidecar
    .start()
    .then(async () => {
      bootElapsed("sidecar healthy");
      debugLog("sidecar healthy; creating window");
      await surfaceStartupQuarantine({
        sidecar,
        dialog,
        shell,
        stderr: (message) => console.error(message),
        paths: appStorageDirs(),
      });
      createWindow(forward);
    })
    .catch((error) => {
      void reportStartupFailure(
        {
          fs,
          dialog,
          shell,
          stderr: (message) => console.error(message),
          paths: appStorageDirs(),
        },
        error,
      ).finally(() => app.quit());
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
 * Self-heal: a hardware-accelerated session that ends
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
 * The one policy exception: repeated GPU crashes in
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
          ` the next launch runs software-rendered`,
      );
    }
  }
});

function logRenderProcessGone(details: Electron.RenderProcessGoneDetails): void {
  console.error(
    `[electron] renderer gone: reason=${details.reason} exitCode=${details.exitCode}` +
      ` electron=${process.versions.electron} chromium=${process.versions.chrome}`,
  );
  replayRendererConsoleTail();
}
