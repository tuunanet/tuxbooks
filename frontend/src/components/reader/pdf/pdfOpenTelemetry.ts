/**
 * Pure PDF-open telemetry math — no React, no DOM, no engine. The reader
 * publishes the open timeline as deterministic `data-pdf-open-*` attributes
 * (docs/PERFORMANCE.md): a state machine over the open path, plus the
 * click→document-open / click→first-paint / click→interactive segments.
 *
 * Timings are diagnostics and manual-benchmark inputs, never deterministic
 * CI assertions; E2E may assert the attribute's shape and state values.
 */

import type { PdfDocumentStatus } from "./hooks/usePdfDocument";

/**
 * The open-path states, in order:
 *
 *   created          — reader mounted, document not requested yet
 *   document-opening — range-backed open in flight
 *   document-ready   — document parsed, page count known
 *   geometry-ready   — page-1 dimensions known, fit-width layout computed
 *   first-render-start — interactive, but no page rendered yet
 *   first-rendered   — first readable page is visible
 *   interactive      — reading position restored, user can interact
 */
export type PdfOpenState =
  | "created"
  | "document-opening"
  | "document-ready"
  | "geometry-ready"
  | "first-render-start"
  | "first-rendered"
  | "interactive";

export interface PdfOpenStateInput {
  status: PdfDocumentStatus;
  hasDocument: boolean;
  layoutReady: boolean;
  restored: boolean;
  hasFirstPaint: boolean;
}

export function pdfOpenState(input: PdfOpenStateInput): PdfOpenState {
  if (input.status === "loading") return "document-opening";
  if (input.status === "error") return "created";
  if (!input.hasDocument) return "created";
  if (!input.layoutReady) return "document-ready";
  if (!input.restored) return "geometry-ready";
  return input.hasFirstPaint ? "interactive" : "first-render-start";
}

export interface PdfOpenTimingParts {
  /** Transport label for the byte source ("range" for the stream open). */
  bytes: string;
  /** Click→document-parsed milliseconds, null until parsed. */
  openMs: number | null;
  /** Click→first rendered page milliseconds, null until first paint. */
  firstPaintMs: number | null;
  /** Click→interactive milliseconds, null until restored+first paint. */
  interactiveMs: number | null;
}

/**
 * One compact `data-pdf-open-timing` value, e.g.
 * `bytes=range;open=143;firstPaint=410;interactive=452`. Absent segments
 * are omitted rather than reported as 0.
 */
export function pdfOpenTiming(parts: PdfOpenTimingParts): string {
  const segments: string[] = [`bytes=${parts.bytes}`];
  if (parts.openMs !== null) segments.push(`open=${Math.round(parts.openMs)}`);
  if (parts.firstPaintMs !== null) segments.push(`firstPaint=${Math.round(parts.firstPaintMs)}`);
  if (parts.interactiveMs !== null) {
    segments.push(`interactive=${Math.round(parts.interactiveMs)}`);
  }
  return segments.join(";");
}
