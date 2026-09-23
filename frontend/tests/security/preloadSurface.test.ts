import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { PRIVILEGED_SCHEMES } from "../../../electron/shared/pathSchema";
import { coverFileUrl } from "@/lib/bridge";

const REPO_ROOT = path.resolve(process.cwd(), "..");

function readRepoFile(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

const PRELOAD_SOURCE = readRepoFile("electron/preload/preload.ts");
const MAIN_SOURCE = readRepoFile("electron/main/index.ts");

/** Every function the preload exposes on window.tuxbooks, in order. */
function exposedApiKeys(): string[] {
  const block = PRELOAD_SOURCE.slice(
    PRELOAD_SOURCE.indexOf("const api = {"),
    PRELOAD_SOURCE.indexOf("export type"),
  );
  return [...block.matchAll(/^ {2}(?:async )?(\w+)\(/gm)].map((match) => match[1] ?? "");
}

/** Frontend source files that mention the raw preload bridge. */
function rawBridgeConsumers(): string[] {
  const srcDir = path.join(process.cwd(), "src");
  const hits: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = fs.readFileSync(full, "utf8");
        if (text.includes("window.tuxbooks") || text.includes("tuxbooks().")) {
          hits.push(path.relative(srcDir, full));
        }
      }
    }
  };
  walk(srcDir);
  return hits;
}

describe("cover URLs name covers, not paths (T-1, T-3)", () => {
  it("builds the URL from the basename of the stored cover path", () => {
    expect(coverFileUrl("/home/user/.local/share/com.tuxbooks.app/covers/9f2c1a.png")).toBe(
      "tuxbooks://cover/9f2c1a.png",
    );
    expect(coverFileUrl("relative/covers/abc.webp")).toBe("tuxbooks://cover/abc.webp");
    expect(coverFileUrl("/etc/shadow")).toBe("tuxbooks://cover/shadow");
  });
});

describe("preload surface audit (T-5)", () => {
  it("exposes exactly the enumerated bridge functions", () => {
    expect(exposedApiKeys()).toEqual([
      "invoke",
      "onEvent",
      "pickDirectory",
      "pickBookFile",
      "pickBookFiles",
      "pickCoverImage",
      "revealBook",
      "storageReport",
      "openDataFolder",
      "openLibraryLocation",
      "copyDataPath",
      "copyLibraryLocationPath",
      "clearCache",
      "fetchBookBytes",
      "pathForFile",
    ]);
  });

  it("touches ipcRenderer only through the shared channel constants", () => {
    const channelUses = [...PRELOAD_SOURCE.matchAll(/ipcRenderer\.(invoke|on)\(([^),]+)/g)].map(
      (match) => (match[2] ?? "").trim(),
    );
    expect(channelUses.length).toBeGreaterThan(0);
    for (const channel of channelUses) {
      expect(channel.startsWith("IPC_CHANNELS."), `raw channel use: ${channel}`).toBe(true);
    }
    expect(PRELOAD_SOURCE).not.toMatch(/ipcRenderer\.send(Sync)?\(/);
    expect(PRELOAD_SOURCE).toMatch(/contextBridge\.exposeInMainWorld\("tuxbooks", api\)/);
  });

  it("has lib/bridge.ts as the only raw bridge consumer in the renderer", () => {
    expect(rawBridgeConsumers()).toEqual(["lib/bridge.ts"]);
  });
});

describe("protocol registration audit (T-5: exactly the privileged schemes)", () => {
  it("registers exactly the shared privileged scheme table", () => {
    expect(MAIN_SOURCE).toContain("registerSchemesAsPrivileged([...PRIVILEGED_SCHEMES])");
  });

  it("handles exactly the tuxbooks and app protocols", () => {
    const handled = [...MAIN_SOURCE.matchAll(/protocol\.handle\("([^"]+)"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(handled.sort()).toEqual(["app", "tuxbooks"]);
    expect(PRIVILEGED_SCHEMES.map((entry) => entry.scheme).sort()).toEqual(["app", "tuxbooks"]);
  });
});
