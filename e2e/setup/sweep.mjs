/**
 * Process sweep for the E2E harness: kills leftover app-tree processes by
 * their /proc/<pid>/exe path — the binary a process IS, not its argv.
 *
 * pkill -f regexes were the previous mechanism, and they overmatched: a
 * justfile recipe shell carrying `TUXBOOKS_SIDECAR=<path>` as an env
 * assignment has the sidecar path in its argv, so a sweep racing the next
 * phase could SIGKILL the recipe itself. exe-based matching cannot hit an
 * unrelated process that merely mentions a target path.
 *
 * Plain Node ESM on purpose — imported by both the launcher-side stale
 * sweep (environment.ts) and the detached watchdog (watchdog.mjs), which
 * must run without any loader/bundler.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** Real executable path of a pid, or null when it is gone/unreadable. */
function processExe(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

/** Start time in jiffies since boot (stat field 22), or null when gone. */
export function processStarttime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
  } catch {
    return null;
  }
}

function killAll(pids) {
  if (pids.length === 0) return;
  try {
    execFileSync("kill", ["-9", ...pids.map(String)]);
  } catch {
    // A target died between the listing and the kill — fine.
  }
}

/**
 * Kill every process whose executable is the Electron app tree (any binary
 * under the resolved dist directory, crashpad helpers included) or the
 * sidecar. `display` (e.g. ":99") additionally sweeps that private Xvfb —
 * its display number only appears in argv, so it keeps a cmdline match,
 * guarded by `notAfterStarttime` so a next phase's fresh Xvfb on a reused
 * display number is never caught by a still-firing old sweep.
 */
export function sweepProcesses({
  electronDist,
  sidecar,
  display = undefined,
  notAfterStarttime = undefined,
}) {
  const pids = [];
  for (const entry of safeReadDir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (pid === process.pid) continue;
    const exe = processExe(pid);
    if (!exe) continue;
    const matches =
      (electronDist ? exe.startsWith(electronDist + "/") : false) ||
      (sidecar ? exe === sidecar : false);
    if (!matches) continue;
    if (notAfterStarttime) {
      const start = processStarttime(pid);
      if (start === null || (notAfterStarttime !== null && start > notAfterStarttime)) continue;
    }
    pids.push(pid);
  }
  killAll(pids);

  if (display) {
    let out;
    try {
      out = execFileSync("pgrep", ["-f", `Xvfb ${display}`]).toString();
    } catch {
      // pgrep exits non-zero when nothing matched — that is the good case.
      return;
    }
    const xvfbPids = out
      .split("\n")
      .map(Number)
      .filter((pid) => pid && pid !== process.pid)
      .filter((pid) => {
        if (!notAfterStarttime) return true;
        const start = processStarttime(pid);
        return start !== null && (notAfterStarttime === null || start <= notAfterStarttime);
      });
    killAll(xvfbPids);
  }
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}
