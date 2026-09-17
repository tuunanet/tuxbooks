/**
 * Window hardening policy (issue #85, X-1..X-4). Pure functions and
 * constants so vitest runs them without Electron; `electron/main/index.ts`
 * wires them into window creation, navigation events, and the session
 * permission handlers.
 *
 * - X-1: `assertRendererIsolation` fails startup when a renderer isolation
 *   flag drifts from the hardened set.
 * - X-3: `isAllowedAppNavigation` is the whole top-frame navigation
 *   allowlist, the app's own origin, plus the dev server origin when a dev
 *   server is actually configured. Everything else, file:// included, is
 *   blocked.
 * - X-4: `isPermissionAllowed` denies every permission by default; the only
 *   grant is fullscreen from the app's own origin (the reader's
 *   presentation mode, ReaderShell's requestFullscreen).
 */

import { APP_ORIGIN } from "../shared/pathSchema";

/**
 * The X-1 renderer isolation set. Every production BrowserWindow must be
 * created with exactly these four flags, explicitly, never left to
 * Electron defaults.
 */
export const RENDERER_ISOLATION = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
} as const;

export type RendererIsolationPrefs = Partial<Record<keyof typeof RENDERER_ISOLATION, boolean>>;

const EXPECTED_ISOLATION: Record<keyof typeof RENDERER_ISOLATION, boolean> = RENDERER_ISOLATION;

/**
 * Throw unless every X-1 flag is present and correct. Called with the
 * literal webPreferences object right before `new BrowserWindow`, so a
 * drifted flag fails startup loudly instead of shipping a softer renderer.
 */
export function assertRendererIsolation(prefs: RendererIsolationPrefs | undefined): void {
  const violations: string[] = [];
  for (const [flag, expected] of Object.entries(EXPECTED_ISOLATION) as [
    keyof typeof RENDERER_ISOLATION,
    boolean,
  ][]) {
    const actual = prefs?.[flag];
    if (actual !== expected) {
      violations.push(`${flag} must be ${expected} (got ${String(actual)})`);
    }
  }
  if (violations.length > 0) {
    throw new Error(`renderer isolation violated: ${violations.join(", ")}`);
  }
}

/**
 * Whether a top-frame navigation to `raw` may proceed (X-3). Allowed: the
 * built app origin's entry point and asset paths, and, only while a dev
 * server is actually configured, that server's origin. Everything else,
 * including file:// and the resource protocol, is blocked; callers must
 * preventDefault the navigation when this returns false.
 */
export function isAllowedAppNavigation(raw: string, devServerUrl: string | undefined): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "app:") {
    return (
      url.host === "bundle" &&
      (url.pathname === "/" ||
        url.pathname === "/index.html" ||
        url.pathname.startsWith("/assets/"))
    );
  }
  if (devServerUrl !== undefined) {
    try {
      return url.origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Origin of a permission request URL, scheme-aware for the app scheme:
 * `new URL().origin` yields the literal "null" for custom schemes
 * (app://bundle is a standard scheme in Chromium but not in the WHATWG JS
 * parser), so the app origin is reconstructed from its validated host.
 * Returns "" for unparseable input.
 */
export function originOfRequestUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "app:") {
      return url.host === "bundle" ? APP_ORIGIN : `app://${url.host}`;
    }
    return url.origin;
  } catch {
    return "";
  }
}

/**
 * The one permission grant rule (X-4): deny by default; fullscreen is the
 * single granted permission and only from the application's own origin
 * (the reader's presentation mode). `requestingOrigin` is an origin string
 * (from `setPermissionCheckHandler`) or derived from the request URL via
 * `originOfRequestUrl` (from `setPermissionRequestHandler` details).
 */
export function isPermissionAllowed(
  permission: string,
  requestingOrigin: string,
  devServerUrl: string | undefined,
): boolean {
  if (permission !== "fullscreen") return false;
  if (requestingOrigin === APP_ORIGIN) return true;
  if (devServerUrl !== undefined) {
    try {
      return requestingOrigin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }
  return false;
}
