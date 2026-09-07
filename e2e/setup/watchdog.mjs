/**
 * E2E teardown watchdog, armed by wdio.conf.ts (onPrepare AND onComplete)
 * and spawned detached so it survives the WebdriverIO launcher.
 *
 * Contract: when the launcher process dies for ANY reason — normal exit,
 * Ctrl+C, or an automation tool killing the whole pipeline mid-run — sweep
 * this run's leftover processes (app tree, Rust sidecar, chromedriver, and
 * the phase's private Xvfb) and remove the scratch dir. An interrupted run
 * therefore cannot leak windows or processes.
 *
 * Sweeping at parent-death is safe for back-to-back phases (`just test-e2e`
 * runs empty then seeded sequentially): the next phase's processes do not
 * exist yet when this phase's launcher dies. There is deliberately NO
 * deadline kill of a live parent — a healthy seeded suite runs for minutes,
 * and a wedged launcher is the justfile `timeout` guard's job, whose kill
 * also triggers this sweep.
 *
 * Plain Node ESM on purpose — must run without any loader/bundler.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const [parentPid, scratchDir, targetsRaw, display = ""] = process.argv.slice(2);
const parent = Number(parentPid);
// Process-name patterns to sweep (electron app tree, sidecar, chromedriver),
// packed by environment.ts with an ASCII unit separator.
const targets = targetsRaw.split("\u001f").filter(Boolean);

/** Start time in jiffies since boot (stat field 22), or null when gone. */
function starttime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
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
  const patterns = targets.map((pattern) => ({ pattern, predate: false }));
  // The display-scoped Xvfb sweep needs the start-time guard: this phase's
  // Xvfb predates the watchdog, but the next phase's may reuse the freed
  // display number while this sweep is still firing. Precise binary-path
  // patterns cannot match the next phase's early recipes, so they need no
  // such guard.
  if (display) patterns.push({ pattern: `Xvfb ${display}`, predate: true });
  for (const { pattern, predate } of patterns) {
    // pgrep + explicit self-exclusion: pkill -f would match this watchdog's
    // own argv (it carries the patterns as arguments).
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
      .filter(
        (entry) =>
          entry &&
          entry.start !== null &&
          (!predate || (ownStart !== null && entry.start <= ownStart)),
      )
      .map((entry) => entry.pid);
    killAll(pids);
  }
  try {
    execFileSync("rm", ["-rf", scratchDir]);
  } catch {
    // Scratch cleanup is best-effort; the next run also clears it.
  }
};

const lifetimeCap = Date.now() + 4 * 60 * 60 * 1000;
const timer = setInterval(() => {
  let parentAlive = true;
  try {
    process.kill(parent, 0);
  } catch {
    parentAlive = false;
  }

  if (parentAlive && Date.now() < lifetimeCap) return;
  clearInterval(timer);

  sweep();
  process.exit(0);
}, 1000);
