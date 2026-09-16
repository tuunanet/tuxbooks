import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  RENDERER_ISOLATION,
  assertRendererIsolation,
  isAllowedAppNavigation,
  isPermissionAllowed,
  originOfRequestUrl,
} from "../../../electron/main/windowSecurity";

const REPO_ROOT = path.resolve(process.cwd(), "..");

function readRepoFile(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

const DEV_SERVER = "http://localhost:1420";

describe("assertRendererIsolation (X-1: window creation fails on a flipped isolation flag)", () => {
  it("accepts the canonical hardened preferences", () => {
    expect(() =>
      assertRendererIsolation({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      }),
    ).not.toThrow();
  });

  it("throws naming each violated flag", () => {
    expect(() =>
      assertRendererIsolation({
        contextIsolation: true,
        nodeIntegration: true,
        sandbox: true,
        webSecurity: true,
      }),
    ).toThrow(/nodeIntegration/);
    expect(() =>
      assertRendererIsolation({
        contextIsolation: false,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      }),
    ).toThrow(/contextIsolation/);
    expect(() =>
      assertRendererIsolation({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true,
      }),
    ).toThrow(/sandbox/);
    expect(() =>
      assertRendererIsolation({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: false,
      }),
    ).toThrow(/webSecurity/);
  });

  it("throws on a missing flag instead of trusting Electron defaults", () => {
    expect(() =>
      assertRendererIsolation({ contextIsolation: true, nodeIntegration: false } as never),
    ).toThrow(/sandbox/);
    expect(() => assertRendererIsolation(undefined)).toThrow();
  });

  it("createWindow passes the literal webPreferences through the assertion", () => {
    const main = readRepoFile("electron/main/index.ts");
    expect(main).toContain("assertRendererIsolation(webPreferences);");
    expect(main).toContain("...RENDERER_ISOLATION,");
    expect(main).not.toMatch(/nodeIntegration:\s*true/);
    expect(main).not.toMatch(/contextIsolation:\s*false/);
    expect(main).not.toMatch(/sandbox:\s*false/);
    expect(main).not.toMatch(/webSecurity:\s*false/);
  });

  it("the canonical set matches the X-1 invariant", () => {
    expect(RENDERER_ISOLATION).toEqual({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    });
  });
});

describe("isAllowedAppNavigation (X-3: top-frame navigation restricted to the app origin)", () => {
  it("allows the built renderer entry point and its assets", () => {
    expect(isAllowedAppNavigation("app://bundle/index.html", undefined)).toBe(true);
    expect(isAllowedAppNavigation("app://bundle/", undefined)).toBe(true);
    expect(isAllowedAppNavigation("app://bundle/assets/index-abc123.js", undefined)).toBe(true);
  });

  it("allows only the configured dev server origin in dev", () => {
    expect(isAllowedAppNavigation("http://localhost:1420/", DEV_SERVER)).toBe(true);
    expect(isAllowedAppNavigation("http://localhost:1420/src/main.tsx", DEV_SERVER)).toBe(true);
  });

  it("blocks the dev server origin when no dev server is configured (production)", () => {
    expect(isAllowedAppNavigation("http://localhost:1420/", undefined)).toBe(false);
  });

  it("blocks file:// navigation (publication content cannot reach local files)", () => {
    expect(isAllowedAppNavigation("file:///etc/passwd", undefined)).toBe(false);
    expect(isAllowedAppNavigation("file:///etc/passwd", DEV_SERVER)).toBe(false);
  });

  it("blocks other schemes and origins", () => {
    expect(isAllowedAppNavigation("tuxbooks://book/1", undefined)).toBe(false);
    expect(isAllowedAppNavigation("javascript:alert(1)", undefined)).toBe(false);
    expect(isAllowedAppNavigation("data:text/html,<p>x</p>", undefined)).toBe(false);
    expect(isAllowedAppNavigation("https://evil.example/", undefined)).toBe(false);
    expect(isAllowedAppNavigation("app://evil/index.html", undefined)).toBe(false);
    expect(isAllowedAppNavigation("app://bundlex/index.html", undefined)).toBe(false);
  });

  it("fails closed on malformed input", () => {
    expect(isAllowedAppNavigation("", undefined)).toBe(false);
    expect(isAllowedAppNavigation("not a url", undefined)).toBe(false);
  });
});

describe("originOfRequestUrl (the app scheme has no WHATWG origin)", () => {
  it("reconstructs the app origin from the validated host", () => {
    expect(originOfRequestUrl("app://bundle/index.html")).toBe("app://bundle");
    expect(originOfRequestUrl("app://bundle/assets/x.js")).toBe("app://bundle");
  });

  it("does not mistake another app host for the app origin", () => {
    expect(originOfRequestUrl("app://evil/index.html")).toBe("app://evil");
  });

  it("passes special-scheme origins through", () => {
    expect(originOfRequestUrl("http://localhost:1420/src/main.tsx")).toBe("http://localhost:1420");
    expect(originOfRequestUrl("https://evil.example/x")).toBe("https://evil.example");
  });

  it("fails closed on garbage", () => {
    expect(originOfRequestUrl("")).toBe("");
    expect(originOfRequestUrl("not a url")).toBe("");
  });
});

describe("isPermissionAllowed (X-4: deny by default, grant only what the reader needs)", () => {
  it("denies every permission from the app origin except fullscreen", () => {
    for (const permission of [
      "geolocation",
      "notifications",
      "media",
      "mediaKeySystem",
      "clipboard-read",
      "clipboard-sanitized-write",
      "display-capture",
      "midi",
      "unknown-future-permission",
    ]) {
      expect(isPermissionAllowed(permission, "app://bundle", undefined)).toBe(false);
    }
    expect(isPermissionAllowed("fullscreen", "app://bundle", undefined)).toBe(true);
  });

  it("grants fullscreen from the dev server origin in dev", () => {
    expect(isPermissionAllowed("fullscreen", "http://localhost:1420", DEV_SERVER)).toBe(true);
    expect(isPermissionAllowed("fullscreen", "http://localhost:1420", undefined)).toBe(false);
  });

  it("denies fullscreen from other origins", () => {
    expect(isPermissionAllowed("fullscreen", "https://evil.example", undefined)).toBe(false);
    expect(isPermissionAllowed("fullscreen", "app://evil", undefined)).toBe(false);
  });

  it("denies unknown origins and malformed input", () => {
    expect(isPermissionAllowed("fullscreen", "", undefined)).toBe(false);
    expect(isPermissionAllowed("fullscreen", "not a url", undefined)).toBe(false);
  });
});
