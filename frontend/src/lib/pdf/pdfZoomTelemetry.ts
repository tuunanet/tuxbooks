/**
 * Opt-in PDF zoom telemetry for diagnosing view-centre anomalies (zooms that
 * land off the pointer, blank canvases after a keyboard zoom). Disabled by
 * default: it only records when switched on, and it records from the renderer
 * so the user can reproduce in the real app and hand back one JSON file.
 *
 * Enable in the running app (DevTools console):
 *   tuxbooksPdfZoomLog.enable()          // then reproduce
 *   tuxbooksPdfZoomLog.note("zoom in")   // optional phase markers
 *   tuxbooksPdfZoomLog.download()        // save tuxbooks-pdf-zoom-log.json
 *
 * Or launch with `VITE_PDF_ZOOM_LOG=1`, or persist across reloads with
 * localStorage.setItem("tuxbooks.pdfZoomLog", "1").
 */

export type PdfZoomSampleType = "initial" | "scroll" | "zoom" | "resize";

export interface PdfZoomSample {
  seq: number;
  /** performance.now(), monotonic within a session. */
  t: number;
  /** Wall-clock ISO time. */
  iso: string;
  type: PdfZoomSampleType;
  /** What started the change: wheel, keyboard-step, typed, fit, reset, ... */
  trigger: string;
  zoomMode: string;
  zoomLevel: number;
  scale: number;
  scrollTop: number;
  scrollLeft: number;
  clientWidth: number;
  clientHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  /** Document element origin in scroll-content coordinates. */
  documentTop: number;
  documentLeft: number;
  /** Document element size. */
  documentWidth: number;
  documentHeight: number;
  /** Viewport centre in scroll-content coordinates. */
  centerScrollX: number;
  centerScrollY: number;
  /** Viewport centre in page-local CSS pixels (relative to the document). */
  centerLocalX: number;
  centerLocalY: number;
  /** Viewport centre in page units (page-local CSS / scale). */
  centerPageUnitsX: number;
  centerPageUnitsY: number;
  /** Reading anchor sampled by the scroll tracker. */
  anchorPage: number | null;
  anchorFraction: number | null;
  /** data-pdf-scroll-policy applied by the last layout change. */
  policy: string;
  /** Cursor position for a wheel zoom, viewport-relative. */
  pointerX: number | null;
  pointerY: number | null;
  /** Anchor page canvas presentation, to spot a blank/off-screen surface. */
  canvasQuality: string | null;
  canvasPosition: string;
  canvasLeft: string;
  canvasTop: string;
  canvasTransform: string;
  canvasBuffer: string;
  /** "full" or the page-local "x,y,w,h" region of the anchor page raster. */
  canvasRegion: string;
  slotRenderState: string | null;
}

export interface PdfZoomNote {
  t: number;
  iso: string;
  text: string;
}

const STORAGE_KEY = "tuxbooks.pdfZoomLog";
const MAX_SAMPLES = 6000;
const MAX_NOTES = 200;

function readInitialFlag(): boolean {
  try {
    if (globalThis.localStorage?.getItem(STORAGE_KEY) === "1") return true;
  } catch {
    // Storage can be unavailable in a sandboxed frame; ignore.
  }
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_PDF_ZOOM_LOG === "1";
}

let enabled = readInitialFlag();
const samples: PdfZoomSample[] = [];
const notes: PdfZoomNote[] = [];
let seq = 0;

export function isPdfZoomTelemetryEnabled(): boolean {
  return enabled;
}

export function setPdfZoomTelemetryEnabled(next: boolean): void {
  enabled = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // Ignore storage failures; the in-memory flag still applies.
  }
  if (next) {
    console.info(
      "[pdf-zoom] telemetry enabled; reproduce, then call tuxbooksPdfZoomLog.download()",
    );
  }
}

export function recordPdfZoomSample(sample: Omit<PdfZoomSample, "seq" | "t" | "iso">): void {
  if (!enabled) return;
  const entry: PdfZoomSample = {
    seq: seq,
    t: performance.now(),
    iso: new Date().toISOString(),
    ...sample,
  };
  seq += 1;
  samples.push(entry);
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
  // A zoom is the interesting event; keep a live line for it only.
  if (sample.type === "zoom") {
    console.info(
      `[pdf-zoom] #${entry.seq} ${entry.trigger} ${entry.zoomMode} ${entry.zoomLevel} ` +
        `scale=${entry.scale.toFixed(4)} scroll=${entry.scrollLeft.toFixed(0)},${entry.scrollTop.toFixed(0)} ` +
        `center=${entry.centerLocalX.toFixed(0)},${entry.centerLocalY.toFixed(0)} canvas=${entry.canvasQuality ?? "none"}`,
    );
  }
}

export function addPdfZoomNote(text: string): void {
  if (!enabled) return;
  notes.push({ t: performance.now(), iso: new Date().toISOString(), text });
  if (notes.length > MAX_NOTES) notes.splice(0, notes.length - MAX_NOTES);
}

export function clearPdfZoomLog(): void {
  samples.length = 0;
  notes.length = 0;
  seq = 0;
}

export function dumpPdfZoomLog(): string {
  return JSON.stringify(
    { version: 1, generatedAt: new Date().toISOString(), notes, samples },
    null,
    2,
  );
}

export function downloadPdfZoomLog(): void {
  const blob = new Blob([dumpPdfZoomLog()], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = globalThis.document?.createElement("a");
  if (!anchor) return;
  anchor.href = url;
  anchor.download = "tuxbooks-pdf-zoom-log.json";
  anchor.click();
  URL.revokeObjectURL(url);
}

interface PdfZoomLogGlobal {
  readonly enabled: boolean;
  readonly count: number;
  enable: () => void;
  disable: () => void;
  clear: () => void;
  note: (text: string) => void;
  dump: () => string;
  download: () => void;
}

function installGlobal(): void {
  const api: PdfZoomLogGlobal = {
    get enabled() {
      return enabled;
    },
    get count() {
      return samples.length;
    },
    enable: () => setPdfZoomTelemetryEnabled(true),
    disable: () => setPdfZoomTelemetryEnabled(false),
    clear: clearPdfZoomLog,
    note: addPdfZoomNote,
    dump: dumpPdfZoomLog,
    download: downloadPdfZoomLog,
  };
  (globalThis as unknown as { tuxbooksPdfZoomLog?: PdfZoomLogGlobal }).tuxbooksPdfZoomLog = api;
}

installGlobal();
