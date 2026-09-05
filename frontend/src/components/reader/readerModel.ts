import type { Annotation, ReadingProgressInput, ReadingProgressRecord } from "@/types/domain";
import {
  isBookmarkAtCfi,
  isBookmarkAtPage,
  type ReaderAnnotationController,
} from "./annotationModel";
import type { ReaderSearchController, ReaderSearchMatch } from "./searchModel";

/**
 * Unified reader model (milestone 8): the shared application-level contract
 * between ReaderShell and the two document readers. The shell owns the
 * current book, progress, navigation entry points, bookmark placement, and
 * the search/annotation drawers; each format reader implements this contract
 * on top of its own engine without the engines sharing an abstraction.
 */

/** Canonical EPUB locator: CFI plus the spine href of its section. */
export interface EpubLocator {
  cfi: string;
  chapterHref: string | null;
}

/**
 * Where the open book is right now, in the document's own coordinates.
 * EPUB locates a canonical CFI (+ spine href for labels); PDF a 1-based
 * page (+ the reading anchor's in-page fraction). Exactly one format's
 * fields exist — the union is the format check.
 */
export type ReaderPosition =
  ({ format: "epub" } & EpubLocator) | { format: "pdf"; page: number; fraction: number };

export type EpubReaderPosition = Extract<ReaderPosition, { format: "epub" }>;
export type PdfReaderPosition = Extract<ReaderPosition, { format: "pdf" }>;

/**
 * A navigation destination. EPUB targets use the engine's own locator
 * grammar (a canonical CFI or a spine href — TOC entries carry hrefs,
 * bookmarks and search matches CFIs); PDF targets are 1-based pages.
 */
export type ReaderJump = { format: "epub"; locator: string } | { format: "pdf"; page: number };

/**
 * What each format reader registers with the shell while its document is
 * open. One ref replaces the per-format controller refs: the shell jumps,
 * searches, and creates highlights without knowing which engine answers.
 */
export interface ReaderAdapter {
  /** Navigate the open document to a position in its own coordinates. */
  jump(target: ReaderJump): void;
  /** Streaming in-book search over the open document. */
  readonly search: ReaderSearchController;
  /** Selection → highlight creation on the open document. */
  readonly annotations: ReaderAnnotationController;
}

/** True when the annotation is a bookmark placed exactly at `position`. */
export function isBookmarkAtPosition(annotation: Annotation, position: ReaderPosition): boolean {
  return position.format === "epub"
    ? isBookmarkAtCfi(annotation, position.cfi)
    : isBookmarkAtPage(annotation, position.page);
}

/** The annotation input that persists a bookmark at `position`. */
export function bookmarkInputFor(position: ReaderPosition) {
  if (position.format === "epub") {
    return { kind: "bookmark" as const, cfi: position.cfi, chapterHref: position.chapterHref };
  }
  return {
    kind: "bookmark" as const,
    pageNumber: position.page,
    pageFraction: position.fraction > 0 ? position.fraction : null,
  };
}

/** Navigation target for an annotation's position, or null when unlocatable. */
export function jumpToAnnotation(annotation: Annotation): ReaderJump | null {
  if (annotation.cfi !== null) return { format: "epub", locator: annotation.cfi };
  if (annotation.pageNumber !== null) return { format: "pdf", page: annotation.pageNumber };
  return null;
}

/** Navigation target for an in-book search match, or null when unlocatable. */
export function jumpToSearchMatch(match: ReaderSearchMatch): ReaderJump | null {
  if (match.cfi !== null) return { format: "epub", locator: match.cfi };
  if (match.page !== null) return { format: "pdf", page: match.page };
  return null;
}

/**
 * Progress persistence mapping. The stored row is format-specific; each
 * reader validates/serializes through these pure helpers so the shared
 * persistence hook stays format-blind.
 */

/** The saved EPUB CFI, or null when absent or not a canonical CFI. */
export function parseEpubProgress(record: ReadingProgressRecord | null): string | null {
  const cfi = record?.cfi;
  return typeof cfi === "string" && cfi.startsWith("epubcfi(") ? cfi : null;
}

export function epubProgressPayload(locator: EpubLocator, position: number): ReadingProgressInput {
  return { cfi: locator.cfi, chapterHref: locator.chapterHref, progressPercent: position };
}

/** The saved 1-based PDF page, or null when absent or out of range. */
export function parsePdfProgress(
  record: ReadingProgressRecord | null,
  pageCount: number,
): number | null {
  const page = record?.pageNumber;
  return typeof page === "number" && Number.isInteger(page) && page >= 1 && page <= pageCount
    ? page
    : null;
}

export function pdfProgressPayload(page: number, position: number): ReadingProgressInput {
  return { pageNumber: page, progressPercent: position };
}
