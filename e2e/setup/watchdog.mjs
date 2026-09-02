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
 * The sweep only kills processes that predate this watchdog (read from
 * /proc/<pid>/stat): anything the NEXT phase already spawned — `just
 * test-e2e` runs two back to back — started later and is left alone. That
 * ownership question cannot be answered via /proc/<pid>/environ (yama
 * ptrace_scope=1 makes siblings' environ unreadable).
 *
 * Plain Node ESM on purpose — must run without any loader/bundler.
 * /proc and process groups are Linux facts; E2E is Linux-only anyway.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [parentPid, graceMs, scratchDir, appBinary, display = ""] = process.argv.slice(2);
const parent = Number(parentPid);

/** Start time in jiffies since boot (stat field 22), or null when the
 *  process is gone or unreadable (nothing to reap, or not ours to judge). */
function starttime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm (field 2) can contain spaces and parens; everything after the
    // last ')' shifts by the first two fields.
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  } catch {
    return null;
  }
}

const ownStart = starttime(process.pid);

function killAll(pids) {
  if (pids.length === 0) return;
  try {
    execFileSync("kill", ["-9", ...pids.map(String)]);
  } catch {
    // A target died between the listing and the kill — fine.
  }
}

const sweep = () => {
  // All targets predate the watchdog by construction: this run's app,
  // tauri-driver, WebKitWebDriver, and Xvfb (spawned by xvfb-run before
  // anything else) all started before arming, while the next phase's
  // processes — `just test-e2e` runs two back to back — start after and
  // are left alone. `Xvfb <display>` is additionally precise: X.org's
  // server is "Xorg" and Wayland's Xwayland is "Xwayland", so it never
  // matches a desktop session, and the display number scopes it to this
  // phase's private server (leaked when `timeout` SIGKILLs xvfb-run
  // before its own cleanup runs).
  const patterns = [appBinary, "tauri-driver", "WebKitWebDriver"];
  if (display) patterns.push(`Xvfb ${display}`);
  for (const pattern of patterns) {
    // pkill -f cannot be used directly: it matches full command lines,
    // including this watchdog's own argv, which carries the app binary
    // path (and display) as real arguments — the sweep would SIGKILL the
    // watchdog itself before finishing. pgrep + an explicit exclusion of
    // our own pid is the only reliable guard.
    let out;
    try {
      out = execFileSync("pgrep", ["-f", pattern]).toString();
    } catch {
      // pgrep exits non-zero when nothing matched — that is the good case.
      continue;
    }
    const pids = out
      .split("\n")
      .map(Number)
      .map((pid) => (pid && pid !== process.pid ? { pid, start: starttime(pid) } : null))
      .filter((p) => p && p.start !== null && p.start <= ownStart)
      .map((p) => p.pid);
    killAll(pids);
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
