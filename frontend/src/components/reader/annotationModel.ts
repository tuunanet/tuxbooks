import type { Annotation, AnnotationKind, AnnotationRect } from "@/types/domain";

/**
 * Format-agnostic annotation state shared by the reader shell, the
 * navigation drawer, and both readers. An annotation carries exactly one
 * locator: EPUB annotations point at a canonical CFI, PDF annotations at a
 * 1-based page (+ optional page-local fraction); PDF highlights add
 * normalized page-space rects.
 */

/** Highlight palette. The key is the stable persisted `color` value. */
export const HIGHLIGHT_COLORS = {
  yellow: "#facc15",
  green: "#4ade80",
  blue: "#60a5fa",
  red: "#f87171",
  purple: "#c084fc",
} as const;

export type HighlightColor = keyof typeof HIGHLIGHT_COLORS;

export const DEFAULT_HIGHLIGHT_COLOR: HighlightColor = "yellow";

export function isHighlightColor(value: string | null | undefined): value is HighlightColor {
  return value !== null && value !== undefined && value in HIGHLIGHT_COLORS;
}

/** CSS color of a stored highlight color name, falling back to yellow. */
export function highlightCssColor(color: string | null | undefined): string {
  return isHighlightColor(color) ? HIGHLIGHT_COLORS[color] : HIGHLIGHT_COLORS.yellow;
}

/**
 * A highlight operation from the selection toolbar. A color choice creates
 * a highlight from a fresh selection or recolors the targeted one; `remove`
 * deletes the targeted highlight annotation outright — never a transparent
 * recolor, which would leave a dead annotation behind.
 */
export type HighlightAction = { type: "setColor"; color: HighlightColor } | { type: "remove" };

/** A live selection (or a clicked highlight) a reader reports to the shell. */
export interface ReaderSelection {
  text: string;
  /** Existing highlight the selection or click targets, if any. */
  highlightId: number | null;
}

function intersectionArea(a: AnnotationRect, b: AnnotationRect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * The existing PDF highlight a text selection targets, if any: the
 * same-page highlight with the largest total rect overlap, so re-selecting
 * highlighted text addresses that highlight instead of stacking a new one
 * on top of it.
 */
export function highlightForSelection(
  highlights: Annotation[],
  page: number,
  rects: AnnotationRect[],
): Annotation | null {
  let best: { annotation: Annotation; area: number } | null = null;
  for (const highlight of highlights) {
    if (highlight.pageNumber !== page) continue;
    let area = 0;
    for (const rect of annotationRects(highlight)) {
      for (const selectionRect of rects) area += intersectionArea(rect, selectionRect);
    }
    if (area > 0 && (best === null || area > best.area)) best = { annotation: highlight, area };
  }
  return best?.annotation ?? null;
}

/**
 * The existing PDF highlight containing a normalized page-space point (a
 * plain click on highlighted text), if any.
 */
export function highlightAtPoint(
  highlights: Annotation[],
  page: number,
  x: number,
  y: number,
): Annotation | null {
  for (const highlight of highlights) {
    if (highlight.pageNumber !== page) continue;
    for (const rect of annotationRects(highlight)) {
      if (x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height) {
        return highlight;
      }
    }
  }
  return null;
}

/** The highlight rectangles to draw for one annotation (PDF only). */
export function annotationRects(annotation: Annotation): AnnotationRect[] {
  return annotation.rects ?? [];
}

/** True when the annotation is a bookmark placed exactly at `locator`. */
export function isBookmarkAtLocator(annotation: Annotation, locator: string): boolean {
  return annotation.kind === "bookmark" && annotation.cfi === locator;
}

/** True when the annotation is a bookmark placed exactly at `page`. */
export function isBookmarkAtPage(annotation: Annotation, page: number): boolean {
  return annotation.kind === "bookmark" && annotation.pageNumber === page;
}

export function byKind(annotations: Annotation[], kind: AnnotationKind): Annotation[] {
  return annotations.filter((annotation) => annotation.kind === kind);
}

/**
 * What each reader (EPUB/PDF) registers with the shell so the selection
 * toolbar can create highlights without knowing the document format. The
 * reader owns the format-specific selection → locator translation.
 */
export interface ReaderAnnotationController {
  /** Creates a persistent highlight from the reader's current selection. */
  createHighlight(color: HighlightColor): void;
  /** Collapses the reader's current selection (creation or dismissal). */
  clearSelection(): void;
}

/**
 * Normalizes a viewport-space rect into the slot's normalized page space
 * (0..1 on both axes), clamped so every stored rect stays inside the page —
 * selection rectangles from the browser can bleed a fraction of a pixel
 * past the edges, which the backend rejects.
 */
export function normalizeRect(
  rect: DOMRect,
  pageLeft: number,
  pageTop: number,
  pageWidth: number,
  pageHeight: number,
): AnnotationRect {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const x = clamp((rect.left - pageLeft) / pageWidth);
  const y = clamp((rect.top - pageTop) / pageHeight);
  const width = clamp((rect.right - pageLeft) / pageWidth) - x;
  const height = clamp((rect.bottom - pageTop) / pageHeight) - y;
  return { x, y, width, height };
}
