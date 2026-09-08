/**
 * Playwright global teardown — runs once after all workers exit. Playwright
 * itself closed the launched app (fixture teardown); this only removes the
 * scratch dir. If the runner was killed instead, globalTeardown never runs
 * and the detached watchdog (armed in global-setup.ts) does the sweep.
 */
import { teardownEnvironment } from "./environment.js";

export default function globalTeardown(): void {
  teardownEnvironment();
}
