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

/** The highlight rectangles to draw for one annotation (PDF only). */
export function annotationRects(annotation: Annotation): AnnotationRect[] {
  return annotation.rects ?? [];
}

/** True when the annotation is a bookmark placed exactly at `cfi`. */
export function isBookmarkAtCfi(annotation: Annotation, cfi: string): boolean {
  return annotation.kind === "bookmark" && annotation.cfi === cfi;
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
