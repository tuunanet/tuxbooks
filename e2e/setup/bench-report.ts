/**
 * Bench report persistence (docs/PERFORMANCE.md "How to measure").
 *
 * The bench suite accumulates one report across every scenario of a run, and
 * the report is only useful if it survives the whole run. Writing it once at
 * the end does not survive that. A Playwright worker restart re-instantiates
 * the spec module with an empty report, so the scenarios that already
 * finished take their numbers into the dead worker's memory, and the final
 * write leaves the restarted worker's survivors overwriting the file. That
 * happened once in practice: bench-results.json held one scenario's section
 * and nulls everywhere else (docs/research/pdf-viewer-perf-findings.md).
 *
 * Every scenario therefore merges its section into whatever the report file
 * already holds, as it finishes. A restart loses at most the scenario in
 * flight, and a later failure cannot take an earlier scenario's numbers with
 * it. The merge rules below are what make an empty section from a freshly
 * restarted module harmless.
 *
 * This module is plain Node. `bench-report.e2e.ts` exercises the
 * persistence contract directly, with no Electron launch and no browser.
 */
import fs from "node:fs";
import path from "node:path";

const REPORT_FILE_NAME = "bench-results.json";
export const TREND_FILE_NAME = "bench-trend.jsonl";

/** rAF frame-interval statistics of one sampling window. */
export interface BenchFrameStats {
  n: number;
  p50: number;
  p95: number;
  max: number;
  /** Share of frames slower than 16.7 ms (dropped vs 60 fps), 30 fps, 20 fps. */
  pctOver16: number;
  pctOver32: number;
  pctOver50: number;
}

/**
 * Render-state distribution over the samples taken while the document was
 * moving. The reader writes three normal states to `data-render-state`
 * (`unloaded`, `rendering`, `rendered`, plus `error` on a failed page), and
 * `rendered` is the only one that shows pixels. The rest is the white
 * placeholder the user reports, so the white count and the longest white run
 * get reported as numbers of their own.
 */
export interface RenderStateShare {
  samples: number;
  rendered: number;
  rendering: number;
  unloaded: number;
  /** Any state that shows no pixels: everything except `rendered`. */
  white: number;
  /** Anything outside the normal three (`error`, or no slot under the centre). */
  other: number;
  renderedSharePct: number;
  renderingSharePct: number;
  /** Longest continuous run of white samples during motion (ms). */
  longestWhiteStreakMs: number;
}

/** Rapid-scroll scenario (docs/PERFORMANCE.md): motion and the stop after it. */
export interface RapidScrollResult {
  /** Wheel events the page received, counted from its own listener. */
  wheelEvents: number;
  /** Scroll-container travel measured during motion (px). */
  distancePx: number;
  /** First wheel event → last wheel event, measured browser-side (ms). */
  motionMs: number;
  renderStates: RenderStateShare | null;
  /**
   * Last wheel event → every visible slot `rendered` (ms). -1 when the
   * reader never got sharp within the scenario's bound. A slot that errored
   * counts as not sharp, because the contract is "every visible slot
   * rendered".
   */
  stopToSharpMs: number;
}

export interface BenchReport {
  timestamp: string;
  environment: {
    userAgent: string;
    devicePixelRatio: number;
    window: { width: number | null; height: number | null };
    pdfRenderInfo: string | null;
  };
  pdf: {
    startPage: number;
    firstRenderLatencyMs: number | null;
    renderMs: number[];
    pageTurnLatencyMs: number[];
    zoomLatencyMs: number[];
    wheelSettleMs: number[];
    bigJumpLatencyMs: number[];
    buffers: { page: number; bufferPx: number; maxSide: number }[];
    cacheAfterOscillation: { entries: number; bytes: number } | null;
    liveCanvases: { count: number; bytes: number; onePageBound: number } | null;
    rapidScroll: RapidScrollResult | null;
    idle: BenchFrameStats | null;
    drag:
      | (BenchFrameStats & { wallMs: number; distancePx: number; renderMsDuringDrag: number[] })
      | null;
  };
  epub: {
    flow: "scrolled";
    measure: string | null;
    firstRenderLatencyMs: number | null;
    chapterChangeLatencyMs: number[];
    idle: BenchFrameStats | null;
    drag: (BenchFrameStats & { wallMs: number; distancePx: number; sectionJumps: number }) | null;
  };
}

/** A report with every scenario section unmeasured, ready to fill in. */
export function emptyReport(timestamp = new Date().toISOString()): BenchReport {
  return {
    timestamp,
    environment: {
      userAgent: "",
      devicePixelRatio: 1,
      window: { width: null, height: null },
      pdfRenderInfo: null,
    },
    pdf: {
      startPage: 0,
      firstRenderLatencyMs: null,
      renderMs: [],
      pageTurnLatencyMs: [],
      zoomLatencyMs: [],
      wheelSettleMs: [],
      bigJumpLatencyMs: [],
      buffers: [],
      cacheAfterOscillation: null,
      liveCanvases: null,
      rapidScroll: null,
      idle: null,
      drag: null,
    },
    epub: {
      flow: "scrolled",
      measure: null,
      firstRenderLatencyMs: null,
      chapterChangeLatencyMs: [],
      idle: null,
      drag: null,
    },
  };
}

export function reportFile(dir: string): string {
  return path.join(dir, REPORT_FILE_NAME);
}

/** The run's report as it stands on disk, or null when nothing wrote yet. */
export function readReport(dir: string): BenchReport | null {
  const file = reportFile(dir);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null; // first scenario of the run, or a wiped artifacts dir.
  }
  try {
    return JSON.parse(raw) as BenchReport;
  } catch {
    console.warn(`[bench] ${file} is unreadable; starting a fresh report`);
    return null;
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Deep-merge `source` over `target`, so one scenario's section joins what is
 * already on disk instead of replacing the file's contents. Whatever the
 * source carries wins; whatever it leaves out survives from disk.
 *
 * What the source carries is `measuredPatch`'s job. This merge carries no
 * rules of its own, which is the point: no list of values that "count as
 * unmeasured", so nothing a scenario measured can be read as a placeholder.
 */
function mergeReports(target: unknown, source: unknown): unknown {
  if (source === null || source === undefined) return target;
  if (isPlainObject(source) && isPlainObject(target)) {
    const merged: Record<string, unknown> = { ...target };
    for (const [name, value] of Object.entries(source)) {
      merged[name] = mergeReports(target[name], value);
    }
    return merged;
  }
  return source;
}

/**
 * The part of `report` a scenario actually measured: every leaf still
 * holding its `emptyReport` default is dropped, and the rest travels whole
 * (objects recurse, arrays and scalars as they are).
 *
 * Default-equality is the whole test, and it needs no list of placeholder
 * values. `pdf.rapidScroll` is null until the scenario runs, so a restarted
 * module cannot publish placeholders over the numbers already collected;
 * once the scenario has filled it in, the section is carried whole, so a
 * measured `rendered: 0` or `stopToSharpMs: -1` inside it reaches the file
 * the same as any other number. The report's own timestamp matches the base
 * by construction and so never rides along, which is what keeps the file
 * naming the first start of the run.
 */
export function measuredPatch(value: unknown, base: unknown): unknown {
  if (isPlainObject(value) && isPlainObject(base)) {
    const patch: Record<string, unknown> = {};
    for (const [name, current] of Object.entries(value)) {
      const part = measuredPatch(current, base[name]);
      if (part !== undefined) patch[name] = part;
    }
    return Object.keys(patch).length > 0 ? patch : undefined;
  }
  return JSON.stringify(value) === JSON.stringify(base) ? undefined : value;
}

/**
 * Merge `report` into the report file under `dir` and return the file path.
 * The suite calls this after every scenario, pass or fail, so the file
 * always holds every scenario that has finished.
 */
export function updateReport(dir: string, report: BenchReport): string {
  const file = reportFile(dir);
  const onDisk = readReport(dir);
  const merged = (
    onDisk
      ? mergeReports(onDisk, measuredPatch(report, emptyReport(report.timestamp)) ?? {})
      : report
  ) as BenchReport;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(merged, null, 2)}\n`);
  return file;
}
