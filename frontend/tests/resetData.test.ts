import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GPU_FALLBACK_MARKER } from "../../electron/main/gpuFallback";
import {
  LAUNCH_COMMAND,
  parseStartupFlags,
  quarantineStamp,
  runDryRun,
  runResetData,
  type ResetDataDeps,
} from "../../electron/main/resetData";
import { CATALOG_DB_FILENAME, COVERS_DIRNAME } from "../../electron/main/storageSizing";

/**
 * Command-line recovery tests (data-management spec): flag parsing, the
 * read-only dry run, and the reset scope. Real temp directories and injected
 * writers, external behavior only: what is printed and what survives.
 */

let dataDir: string;
let configDir: string;
let outsideDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reset-data-"));
  configDir = fs.mkdtempSync(path.join(os.tmpdir(), "reset-config-"));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "reset-outside-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

function write(filePath: string, bytes: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 1));
}

/** Relative path to size for every file under `root`, symlinks excluded. */
function snapshot(root: string): Record<string, number> {
  const entries: Record<string, number> = {};
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let names: string[];
    try {
      names = fs.readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names) {
      const full = path.join(current, name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) {
        stack.push(full);
      } else {
        entries[path.relative(root, full)] = stat.size;
      }
    }
  }
  return entries;
}

function harness(overrides: Partial<ResetDataDeps> = {}): {
  deps: ResetDataDeps;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const deps: ResetDataDeps = {
    fs,
    dirs: { dataDir, configDir },
    stdout: (message) => out.push(message),
    stderr: (message) => err.push(message),
    ...overrides,
  };
  return { deps, out, err };
}

describe("startup flag parsing", () => {
  it("recognizes --dry-run and --reset-data", () => {
    expect(parseStartupFlags(["--dry-run"])).toEqual({ dryRun: true, resetData: false });
    expect(parseStartupFlags(["--reset-data"])).toEqual({ dryRun: false, resetData: true });
    expect(parseStartupFlags(["--reset-data", "--dry-run"])).toEqual({
      dryRun: true,
      resetData: true,
    });
  });

  it("ignores unrelated arguments", () => {
    expect(parseStartupFlags(["electron", ".", "--verbose", "book.epub"])).toEqual({
      dryRun: false,
      resetData: false,
    });
    expect(parseStartupFlags(["--reset-data=1"])).toEqual({ dryRun: false, resetData: false });
  });
});

describe("--dry-run", () => {
  it("prints the resolved paths and sizes and changes nothing", () => {
    write(path.join(dataDir, CATALOG_DB_FILENAME), 1000);
    write(path.join(dataDir, COVERS_DIRNAME, "cover.png"), 300);
    write(path.join(configDir, "Cache", "a"), 400);
    write(path.join(configDir, "Preferences"), 7);
    const beforeData = snapshot(dataDir);
    const beforeConfig = snapshot(configDir);
    const { deps, out } = harness();

    runDryRun(deps);

    expect(out).toHaveLength(1);
    const text = out[0]!;
    expect(text).toContain(dataDir);
    expect(text).toContain(configDir);
    expect(text).toContain("1000 bytes");
    expect(text).toContain("1300 bytes");
    expect(snapshot(dataDir)).toEqual(beforeData);
    expect(snapshot(configDir)).toEqual(beforeConfig);
  });
});

describe("--reset-data", () => {
  const WHEN = new Date("2026-09-22T08:00:00.000Z");

  it("quarantines the database, clears app data, and leaves book files untouched", async () => {
    const database = path.join(dataDir, CATALOG_DB_FILENAME);
    write(database, 1000);
    write(`${database}-wal`, 40);
    write(`${database}-shm`, 10);
    write(path.join(dataDir, COVERS_DIRNAME, "cover.png"), 300);
    write(path.join(dataDir, GPU_FALLBACK_MARKER), 5);
    write(path.join(dataDir, "book.epub"), 500);
    write(path.join(configDir, "Cache", "a"), 400);
    write(path.join(configDir, "Preferences"), 7);
    write(path.join(configDir, "Local Storage", "state"), 9);
    const outsideBook = path.join(outsideDir, "outside.epub");
    write(outsideBook, 700);
    const quarantinedPath = `${database}.corrupt-${quarantineStamp(WHEN)}`;
    const { deps, out } = harness({ now: () => WHEN });

    const report = await runResetData(deps);

    expect(report.quarantined).toEqual({ from: database, to: quarantinedPath });
    expect(fs.existsSync(database)).toBe(false);
    expect(fs.existsSync(`${database}-wal`)).toBe(false);
    expect(fs.existsSync(`${database}-shm`)).toBe(false);
    expect(fs.readFileSync(quarantinedPath).length).toBe(1000);
    expect(fs.readFileSync(`${quarantinedPath}-wal`).length).toBe(40);
    expect(fs.readFileSync(`${quarantinedPath}-shm`).length).toBe(10);

    expect(fs.existsSync(path.join(dataDir, COVERS_DIRNAME))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, GPU_FALLBACK_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(configDir, "Cache"))).toBe(false);
    expect(fs.existsSync(path.join(configDir, "Preferences"))).toBe(false);
    expect(fs.existsSync(path.join(configDir, "Local Storage"))).toBe(false);

    expect(fs.readFileSync(path.join(dataDir, "book.epub")).length).toBe(500);
    expect(fs.readFileSync(outsideBook).length).toBe(700);

    const text = out.join("\n");
    expect(text).toContain(dataDir);
    expect(text).toContain(configDir);
    expect(text).toContain(quarantinedPath);
    expect(text).toContain(LAUNCH_COMMAND);
    expect(text).toContain("No book files were touched");
  });

  it("starts clean without a quarantine when the database is already absent", async () => {
    write(path.join(dataDir, "book.epub"), 500);
    write(path.join(configDir, "Cache", "a"), 400);
    const { deps } = harness({ now: () => WHEN });

    const report = await runResetData(deps);

    expect(report.quarantined).toBeNull();
    expect(fs.existsSync(path.join(configDir, "Cache"))).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, "book.epub")).length).toBe(500);
  });

  it("refuses a cover cache that is a symlink out of the data root", async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "reset-covers-outside-"));
    write(path.join(outside, "secret.epub"), 9999);
    try {
      fs.symlinkSync(outside, path.join(dataDir, COVERS_DIRNAME), "dir");
    } catch {
      fs.rmSync(outside, { recursive: true, force: true });
      return;
    }
    try {
      const { deps } = harness({ now: () => WHEN });

      await runResetData(deps);

      expect(fs.existsSync(path.join(outside, "secret.epub"))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, COVERS_DIRNAME))).toBe(true);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
