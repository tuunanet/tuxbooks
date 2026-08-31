/**
 * E2E teardown watchdog, armed by wdio.conf.ts::onComplete and spawned
 * detached so it survives the WebdriverIO launcher.
 *
 * Why: the Tauri app (spawned by WebKitWebDriver under tauri-driver) can
 * outlive the test run while holding the inherited stdout pipe, wedging the
 * invoking shell. Normal runs: the parent exits within seconds and the sweep
 * below just reaps any leftovers. Wedged teardowns: after the grace period
 * the watchdog SIGKILLs leftover processes and the parent itself, so an E2E
 * invocation always terminates (with a failure code, never a hang).
 *
 * Plain Node ESM on purpose — must run without any loader/bundler.
 */
import { execFileSync } from "node:child_process";

const [parentPid, graceMs, scratchDir, appBinary] = process.argv.slice(2);
const parent = Number(parentPid);

const sweep = () => {
  for (const pattern of [appBinary, "tauri-driver", "WebKitWebDriver"]) {
    try {
      execFileSync("pkill", ["-9", "-f", pattern]);
    } catch {
      // pkill exits non-zero when nothing matched — that is the good case.
    }
  }
};

const deadline = Date.now() + Number(graceMs);
const timer = setInterval(() => {
  let parentAlive = true;
  try {
    process.kill(parent, 0);
  } catch {
    parentAlive = false;
  }

  if (parentAlive && Date.now() < deadline) return;
  clearInterval(timer);

  sweep();
  if (parentAlive) {
    try {
      process.kill(parent, "SIGKILL");
    } catch {
      // Parent already gone between the check and the kill.
    }
  }
  try {
    execFileSync("rm", ["-rf", scratchDir]);
  } catch {
    // Scratch cleanup is best-effort; the next run also clears it.
  }
  process.exit(parentAlive ? 1 : 0);
}, 1000);
