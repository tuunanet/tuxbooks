import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Options } from "@wdio/types";

const here = path.dirname(fileURLToPath(import.meta.url));
const appBinary =
  process.env.E2E_APP_BIN ?? path.resolve(here, "../src-tauri/target/debug/tuxbooks");
const fixtureEpub = path.resolve(here, "../tests/fixtures/books/minimal.epub");

// Each invocation gets a fresh scratch dir. E2E_SEED_LIBRARY=1 copies the fixture
// into the test library before the app launches; the app then imports it on startup.
const seeded = process.env.E2E_SEED_LIBRARY === "1";
const scratch = path.resolve(here, ".tmp/run");
const libraryDir = path.join(scratch, "library");

// Port arrangement:
//   4444 - WebDriver protocol endpoint (tauri-driver); WebdriverIO connects here.
//   4445 - tauri-driver <-> native driver (WebKitWebDriver) relay port.
const DRIVER_PORT = 4444;
const NATIVE_PORT = 4445;

let driver: ChildProcess | undefined;

export const config: Options.Testrunner = {
  runner: "local",
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  hostname: "127.0.0.1",
  port: DRIVER_PORT,
  connectionRetryCount: 15,
  connectionRetryTimeout: 45000,
  waitforTimeout: 10000,
  specFileRetries: 1,
  capabilities: [
    {
      // Force WebDriver Classic: WebKitWebDriver has no BiDi support, and WebdriverIO
      // 9 otherwise requests `webSocketUrl` for every non-Safari session.
      "wdio:enforceWebDriverClassic": true,
      "tauri:options": {
        application: appBinary,
      },
    } as never,
  ],
  onPrepare() {
    // The app outlives tauri-driver (WebKit automation connects outbound), so
    // a stale instance from a previous run would grab this session and show
    // its own stale state. Clear the field before spawning.
    try {
      execFileSync("pkill", ["-f", appBinary]);
    } catch {
      // pkill exits non-zero when nothing matched — that is the good case.
    }

    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(libraryDir, { recursive: true });
    if (seeded) {
      copyFileSync(fixtureEpub, path.join(libraryDir, "minimal.epub"));
    }
    // The app (spawned by tauri-driver) inherits these; production paths are unaffected.
    process.env.TEST_DATABASE_PATH = path.join(scratch, "tuxbooks.db");
    process.env.TEST_LIBRARY_PATH = libraryDir;

    driver = spawn(
      "tauri-driver",
      ["--port", String(DRIVER_PORT), "--native-port", String(NATIVE_PORT)],
      { stdio: "inherit", env: process.env },
    );
    driver.on("error", (err) => {
      throw new Error(`failed to start tauri-driver: ${err.message}`);
    });
  },
  onComplete() {
    driver?.kill();
    rmSync(scratch, { recursive: true, force: true });
  },
};
