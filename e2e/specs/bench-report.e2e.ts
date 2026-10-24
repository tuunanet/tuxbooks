/**
 * Regression test for the bench report writer (e2e/setup/bench-report.ts,
 * issue tuxbooks-x27.1). Runs in the seeded phase so it executes on every
 * `just test-e2e`; it needs no app, so it imports Playwright's base test —
 * the electron-app fixture's auto fixtures would launch the app for a test
 * that only touches files.
 *
 * The bug this guards: the suite used to write bench-results.json once, in
 * afterAll, from worker-local module state, so a scenario that failed late
 * — or a worker restart that re-instantiated the module — wiped the
 * numbers already collected.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { recordScenario, readBenchReport, type BenchEnvironment } from "../setup/bench-report.js";

const environment: BenchEnvironment = {
  userAgent: "bench-agent/1.0",
  devicePixelRatio: 1.453,
  window: { width: 2643, height: 1405 },
  pdfRenderInfo: "bytes=range;open=16;firstPaint=238",
};

/** Simulates the state a restarted worker's fresh module carries. */
const emptyEnvironment: BenchEnvironment = {
  userAgent: "",
  devicePixelRatio: 0,
  window: { width: null, height: null },
  pdfRenderInfo: null,
};

function scratchReport(): { dir: string; file: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tuxbooks-bench-report-"));
  return { dir, file: path.join(dir, "bench-results.json") };
}

test.describe("bench report persistence", () => {
  test("results are durable as soon as a scenario records them", async () => {
    const { dir, file } = scratchReport();
    try {
      const pageWalk = {
        startPage: 58,
        firstRenderLatencyMs: 720,
        renderMs: [131.4, 381],
        buffers: [{ page: 58, bufferPx: 40265318, maxSide: 6000 }],
        cacheAfterOscillation: { entries: 2, bytes: 80530636 },
        liveCanvases: { count: 3, bytes: 230686720, onePageBound: 268435456 },
      };
      recordScenario(file, "pdf-page-walk", pageWalk, environment);
      // A later scenario fails before it records anything; the earlier
      // results must already be on disk, untouched.
      const report = readBenchReport(file);
      expect(report?.scenarios["pdf-page-walk"]).toEqual(pageWalk);
      expect(report?.environment).toEqual(environment);
      expect(report?.environment).toEqual(environment);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a restarted worker's record does not clobber collected results", async () => {
    const { dir, file } = scratchReport();
    try {
      recordScenario(file, "pdf-scroll-drag", { idle: null, drag: null }, environment);
      const original = readBenchReport(file);

      // The worker restarted between scenarios: the next record arrives from
      // a fresh module — empty environment, a new timestamp inside the
      // writer — and only carries its own scenario.
      const rapidScroll = {
        startPage: 58,
        wheelEvents: 260,
        pxPerWheelEvent: 600,
        distancePx: 156000,
        motionMs: 8980,
        samples: 342,
        renderStates: { rendering: 336, unloaded: 5, rendered: 1, error: 0 },
        renderStateSharePct: { rendering: 98.2, unloaded: 1.5, rendered: 0.3, error: 0 },
        longestWhiteStreakMs: 8400,
        stopToSharpMs: 314,
      };
      recordScenario(file, "pdf-rapid-scroll", rapidScroll, emptyEnvironment);
      const merged = readBenchReport(file);

      expect(merged?.timestamp).toBe(original?.timestamp);
      expect(merged?.environment).toEqual(environment);
      expect(merged?.scenarios["pdf-scroll-drag"]).toEqual({ idle: null, drag: null });
      expect(merged?.scenarios["pdf-rapid-scroll"]).toEqual(rapidScroll);
      // The file parses as written, both scenarios present.
      expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).scenarios).sort()).toEqual([
        "pdf-rapid-scroll",
        "pdf-scroll-drag",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
