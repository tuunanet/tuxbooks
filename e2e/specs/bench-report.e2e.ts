/**
 * Regression tests for bench report persistence (setup/bench-report.ts).
 *
 * The bench suite collects one report across every scenario of a run, and
 * the report used to be written once, at the very end. That loses numbers. A
 * Playwright worker restart re-instantiates the spec module with an empty
 * report, so the scenarios that already finished leave with the dead worker,
 * and the final write puts the survivors over the file. It happened once in
 * practice, as a bench-results.json holding one scenario's section and nulls
 * everywhere else (docs/research/pdf-viewer-perf-findings.md).
 *
 * These tests pin the fix without launching the app. The writer is plain
 * Node, so the tests exercise the whole contract against a real file. Each
 * test stands in for one bench scenario finishing, or dying, and commits the
 * way bench-reader.e2e.ts does.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  emptyReport,
  measuredPatch,
  readReport,
  reportFile,
  updateReport,
  type BenchReport,
} from "../setup/bench-report.js";

const tempDirs: string[] = [];

test.afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

/** A scratch artifacts dir, standing in for one run's `artifacts/e2e/<runId>`. */
function scratchDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tuxbooks-bench-report-"));
  tempDirs.push(dir);
  return dir;
}

/** The report as the PDF page-walk scenario leaves it: its own numbers. */
function afterPdfWalk(): BenchReport {
  const report = emptyReport("2026-10-23T08:00:00.000Z");
  report.environment.userAgent = "Mozilla/5.0 (bench)";
  report.environment.window = { width: 1920, height: 1040 };
  report.pdf.startPage = 58;
  report.pdf.firstRenderLatencyMs = 2140;
  report.pdf.renderMs = [180, 205, 292];
  report.pdf.buffers = [{ page: 58, bufferPx: 2097152, maxSide: 2048 }];
  return report;
}

/** The report as the rapid-scroll scenario leaves it: its own numbers. */
function afterRapidScroll(): BenchReport {
  const report = emptyReport("2026-10-23T08:05:00.000Z");
  report.pdf.rapidScroll = {
    wheelEvents: 260,
    distancePx: 156_000,
    motionMs: 9000,
    renderStates: {
      samples: 342,
      rendered: 1,
      rendering: 336,
      unloaded: 5,
      white: 341,
      other: 0,
      renderedSharePct: 0.3,
      renderingSharePct: 98.2,
      longestWhiteStreakMs: 8400,
    },
    stopToSharpMs: 314,
  };
  return report;
}

test.describe("bench report persistence", () => {
  test("every scenario of a run lands in the report file", () => {
    const dir = scratchDir();

    // Two scenarios of one run, in order, each committing what it measured.
    updateReport(dir, afterPdfWalk());
    updateReport(dir, afterRapidScroll());

    const onDisk = readReport(dir);
    expect(onDisk?.pdf.renderMs).toEqual([180, 205, 292]);
    expect(onDisk?.pdf.rapidScroll?.stopToSharpMs).toBe(314);
    expect(onDisk?.pdf.rapidScroll?.renderStates?.renderingSharePct).toBe(98.2);
    expect(onDisk?.environment.window).toEqual({ width: 1920, height: 1040 });
  });

  test("a failing later scenario leaves earlier scenarios' numbers intact", () => {
    const dir = scratchDir();

    updateReport(dir, afterPdfWalk());

    // The next scenario dies half way through. Its afterEach still commits,
    // carrying what it measured and nothing of what it never reached.
    const dying = emptyReport("2026-10-23T08:02:00.000Z");
    dying.pdf.pageTurnLatencyMs = [44];
    updateReport(dir, dying);

    const onDisk = readReport(dir);
    // The completed scenario survived…
    expect(onDisk?.pdf.renderMs).toEqual([180, 205, 292]);
    expect(onDisk?.pdf.firstRenderLatencyMs).toBe(2140);
    // …and the dying one's partial numbers landed.
    expect(onDisk?.pdf.pageTurnLatencyMs).toEqual([44]);
  });

  test("a restarted worker cannot wipe the scenarios it did not run", () => {
    const dir = scratchDir();

    // Before the restart: the page-walk scenario finished and committed.
    updateReport(dir, afterPdfWalk());

    // The worker restarts; the spec module is re-instantiated with a fresh
    // report, and the rapid-scroll scenario of the same run commits into it.
    updateReport(dir, afterRapidScroll());

    const onDisk = readReport(dir);
    // The restarted instance's section replaced its own empty placeholder…
    expect(onDisk?.pdf.rapidScroll?.wheelEvents).toBe(260);
    // …and the dead instance's completed scenario survived.
    expect(onDisk?.pdf.renderMs).toEqual([180, 205, 292]);
    expect(onDisk?.pdf.startPage).toBe(58);
  });

  test("a re-run of a scenario replaces its own numbers instead of appending", () => {
    const dir = scratchDir();

    updateReport(dir, afterPdfWalk());
    const rerun = afterPdfWalk();
    rerun.pdf.renderMs = [240, 260];
    updateReport(dir, rerun);

    expect(readReport(dir)?.pdf.renderMs).toEqual([240, 260]);
  });

  test("the report file names the run's first start", () => {
    const dir = scratchDir();

    updateReport(dir, afterPdfWalk());
    updateReport(dir, afterRapidScroll());

    expect(readReport(dir)?.timestamp).toBe("2026-10-23T08:00:00.000Z");
  });

  test("an unreadable report file starts a fresh one instead of throwing", () => {
    const dir = scratchDir();
    const file = reportFile(dir);
    updateReport(dir, afterPdfWalk());

    // A truncated write (disk full, killed process) must not wedge the run.
    writeFileSync(file, '{"pdf": {"ren');

    expect(readReport(dir)).toBeNull();
    updateReport(dir, afterRapidScroll());
    expect(readReport(dir)?.pdf.rapidScroll?.stopToSharpMs).toBe(314);
  });

  test("mergeRules: an unrun report carries nothing, a measured zero carries through", () => {
    const dir = scratchDir();
    updateReport(dir, afterPdfWalk());

    // A freshly restarted module has measured nothing, so its patch is
    // empty and the file does not move.
    const fresh = emptyReport("2026-10-23T09:00:00.000Z");
    expect(measuredPatch(fresh, emptyReport(fresh.timestamp))).toBeUndefined();
    updateReport(dir, fresh);

    const onDisk = readReport(dir);
    expect(onDisk?.pdf.renderMs).toEqual([180, 205, 292]);
    expect(onDisk?.pdf.startPage).toBe(58);
    expect(onDisk?.environment.userAgent).toBe("Mozilla/5.0 (bench)");
    expect(onDisk?.timestamp).toBe("2026-10-23T08:00:00.000Z");

    // A measured zero is a measurement. "Nothing white during motion" is
    // the fix's own success signal, and it has to reach the file instead of
    // losing to the earlier run's numbers.
    const sharp = afterRapidScroll();
    const states = sharp.pdf.rapidScroll!.renderStates!;
    states.rendered = states.samples;
    states.rendering = 0;
    states.unloaded = 0;
    states.white = 0;
    states.renderedSharePct = 100;
    states.renderingSharePct = 0;
    states.longestWhiteStreakMs = 0;
    sharp.pdf.rapidScroll!.stopToSharpMs = -1;
    updateReport(dir, sharp);

    const repaired = readReport(dir);
    expect(repaired?.pdf.rapidScroll?.renderStates?.rendering).toBe(0);
    expect(repaired?.pdf.rapidScroll?.renderStates?.white).toBe(0);
    expect(repaired?.pdf.rapidScroll?.renderStates?.longestWhiteStreakMs).toBe(0);
    expect(repaired?.pdf.rapidScroll?.stopToSharpMs).toBe(-1);
    // Sections it never touched are still there.
    expect(repaired?.pdf.renderMs).toEqual([180, 205, 292]);
    expect(repaired?.environment.userAgent).toBe("Mozilla/5.0 (bench)");
  });
});
