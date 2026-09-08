/**
 * E2E teardown watchdog, armed by the Playwright global setup and spawned
 * detached so it survives the Playwright runner.
 *
 * Contract: when the runner process dies for ANY reason — normal exit,
 * Ctrl+C, or an automation tool killing the whole pipeline mid-run — sweep
 * this run's leftover processes (the Electron app tree with its dist
 * helpers, the Rust sidecar, and the phase's private Xvfb) and remove the
 * scratch dir. An interrupted run therefore cannot leak windows or
 * processes. Playwright's own teardown closes the launched app first; the
 * watchdog covers everything short of that (see setup/sweep.mjs for the
 * exe-based match, which cannot hit a process that merely mentions a
 * target path in its argv).
 *
 * Sweeping at parent-death is safe for back-to-back phases (`just test-e2e`
 * runs empty then seeded sequentially): the next phase's processes do not
 * exist yet when this phase's runner dies. There is deliberately NO
 * deadline kill of a live parent — a healthy seeded suite runs for minutes,
 * and a wedged launcher is the justfile `timeout` guard's job, whose kill
 * also triggers this sweep.
 *
 * Plain Node ESM on purpose — must run without any loader/bundler.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

import { processStarttime, sweepProcesses } from "./sweep.mjs";

const [parentPid, scratchDir, targetsRaw, display = ""] = process.argv.slice(2);
const parent = Number(parentPid);
// Sweep targets (electron app dist tree, sidecar binary), packed by
// environment.ts with an ASCII unit separator.
const [electronDist, sidecar] = targetsRaw.split("\u001f");

const ownStart = processStarttime(process.pid);

const sweep = () => {
  sweepProcesses({
    electronDist,
    sidecar,
    // The display-scoped Xvfb sweep needs the start-time guard: this
    // phase's Xvfb predates the watchdog, but the next phase's may reuse
    // the freed display number while this sweep is still firing.
    display: display || undefined,
    notAfterStarttime: ownStart,
  });
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
