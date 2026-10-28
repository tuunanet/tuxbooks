/**
 * The bench suite's report file (docs/PERFORMANCE.md "How to measure").
 *
 * Results are persisted per scenario as soon as the scenario has collected
 * them: each `recordScenario` call merges one scenario's section into the
 * file on disk, so a scenario that fails later — or a Playwright worker
 * restart that re-instantiates the suite module with empty state — can no
 * longer overwrite numbers already collected. The file is the source of
 * truth: reads happen at record time and in the suite's `afterAll` (trend
 * line, console summaries), never from worker-local state.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Frame-cadence summary shared by the scroll and idle samples. */
export interface FrameStats {
  n: number;
  p50: number;
  p95: number;
  max: number;
  /** Share of frames slower than 16.7 ms (dropped vs 60 fps), 30 fps, 20 fps. */
  pctOver16: number;
  pctOver32: number;
  pctOver50: number;
}

export interface BenchEnvironment {
  userAgent: string;
  devicePixelRatio: number;
  window: { width: number | null; height: number | null };
  pdfRenderInfo: string | null;
}

export interface PdfPageWalkResult {
  startPage: number;
  firstRenderLatencyMs: number | null;
  renderMs: number[];
  buffers: { page: number; bufferPx: number; maxSide: number }[];
  cacheAfterOscillation: { entries: number; bytes: number } | null;
  liveCanvases: { count: number; bytes: number; onePageBound: number } | null;
}

export interface PdfScrollDragResult {
  idle: FrameStats | null;
  drag: (FrameStats & { wallMs: number; distancePx: number; renderMsDuringDrag: number[] }) | null;
}

export interface PdfInteractionResult {
  pageTurnLatencyMs: number[];
  zoomLatencyMs: number[];
  wheelSettleMs: number[];
  bigJumpLatencyMs: number[];
}

/**
 * The rapid-scroll capture promoted into the suite (issue tuxbooks-x27.1).
 * Counts are over the sampled motion window; the baseline recorded in
 * docs/research/pdf-viewer-perf-findings.md is 98% rendering share, an
 * 8,400 ms longest white streak, and 314 ms stop-to-sharp.
 */
export interface PdfRapidScrollResult {
  startPage: number;
  /** Wheel events the page actually received — real input, not synthesized scroll writes. */
  wheelEvents: number;
  pxPerWheelEvent: number;
  distancePx: number;
  /** Observed motion window: first scroll-position change to the last one. */
  motionMs: number;
  /** 25 ms samples taken while the viewport slot was in motion. */
  samples: number;
  renderStates: { rendering: number; unloaded: number; rendered: number; error: number };
  renderStateSharePct: { rendering: number; unloaded: number; rendered: number; error: number };
  /** Longest continuous run of motion samples the viewport slot was not painted. */
  longestWhiteStreakMs: number;
  /** Scroll-stop (last position change) → every visible slot rendered; null when it never sharpened. */
  stopToSharpMs: number | null;
}

export interface EpubChapterChangeResult {
  firstRenderLatencyMs: number | null;
  chapterChangeLatencyMs: number[];
}

export interface EpubScrollDragResult {
  flow: "scrolled";
  measure: string | null;
  idle: FrameStats | null;
  drag: (FrameStats & { wallMs: number; distancePx: number; sectionJumps: number }) | null;
}

export interface LibraryGridScrollResult {
  bookCount: number;
  idle: FrameStats;
  scroll: FrameStats & {
    wallMs: number;
    distancePx: number;
    maxObservedMountedCards: number;
  };
}

/** One section per scenario; scenarios absent from a run stay undefined. */
export interface BenchScenarios {
  "pdf-page-walk"?: PdfPageWalkResult;
  "pdf-scroll-drag"?: PdfScrollDragResult;
  "pdf-interaction"?: PdfInteractionResult;
  "pdf-rapid-scroll"?: PdfRapidScrollResult;
  "epub-chapter-change"?: EpubChapterChangeResult;
  "epub-scroll-drag"?: EpubScrollDragResult;
  "library-grid-scroll"?: LibraryGridScrollResult;
}

export interface BenchReport {
  /** The run's first record time; a restarted worker never restamps it. */
  timestamp: string;
  environment: BenchEnvironment;
  scenarios: BenchScenarios;
}

export function readBenchReport(file: string): BenchReport | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as BenchReport;
  } catch {
    // Absent or unreadable: the next record starts a fresh report.
    return null;
  }
}

/**
 * Non-empty incoming values win per field; an incoming empty value (the
 * fresh-module defaults a restarted worker carries) never clobbers what is
 * already on disk.
 */
function mergeEnvironment(
  existing: BenchEnvironment,
  incoming: BenchEnvironment,
): BenchEnvironment {
  return {
    userAgent: incoming.userAgent || existing.userAgent,
    devicePixelRatio: incoming.devicePixelRatio || existing.devicePixelRatio,
    window: {
      width: incoming.window.width ?? existing.window.width,
      height: incoming.window.height ?? existing.window.height,
    },
    pdfRenderInfo: incoming.pdfRenderInfo ?? existing.pdfRenderInfo,
  };
}

/**
 * Merge one record into the persisted report. Timestamp and environment
 * survive every merge (first writer wins for the stamp); scenario sections
 * merge per key, so each scenario only ever overwrites itself.
 */
function mergeBenchReport(existing: BenchReport | null, incoming: BenchReport): BenchReport {
  if (existing === null) return incoming;
  const scenarios = { ...existing.scenarios };
  for (const key of Object.keys(incoming.scenarios) as (keyof BenchScenarios)[]) {
    const value = incoming.scenarios[key];
    // Object.assign, not an indexed write: with a union key TypeScript
    // would require every section type to be assignable to the others.
    if (value !== undefined) Object.assign(scenarios, { [key]: value });
  }
  return {
    timestamp: existing.timestamp,
    environment: mergeEnvironment(existing.environment, incoming.environment),
    scenarios,
  };
}

/** Merge one scenario's results into the report file on disk. */
export function recordScenario<K extends keyof BenchScenarios>(
  file: string,
  scenario: K,
  data: BenchScenarios[K],
  environment: BenchEnvironment,
): void {
  const existing = readBenchReport(file);
  const incoming: BenchReport = {
    timestamp: new Date().toISOString(),
    environment,
    scenarios: { [scenario]: data } as BenchScenarios,
  };
  const merged = mergeBenchReport(existing, incoming);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(merged, null, 2));
}
