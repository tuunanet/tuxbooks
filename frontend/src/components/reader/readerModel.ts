import type { Annotation, ReadingProgressInput, ReadingProgressRecord } from "@/types/domain";
import {
  isBookmarkAtPage,
  isBookmarkAtLocator,
  type ReaderAnnotationController,
} from "./annotationModel";
import type { ReaderSearchController, ReaderSearchMatch } from "./searchModel";

/**
 * Unified reader model (milestone 8): the shared application-level contract
 * between ReaderShell and the two document readers. The shell owns the
 * current book, progress, navigation entry points, bookmark placement, and
 * the search/annotation drawers; each format reader implements this contract
 * on top of its own engine without the engines sharing an abstraction.
 *
 * EPUB locator grammar (phase 3, docs/EPUB.md): the canonical locator is
 * the serialized Readium `Locator` JSON. Legacy foliate CFIs (progress
 * rows, stored annotations from before the engine swap) convert through
 * `lib/epub/progressMigration.ts` inside the engine seam at restore/jump
 * time — the shell and the Rust rows never need to know.
 */

/** Canonical EPUB locator: serialized Readium locator JSON + spine href. */
export interface EpubLocator {
  /** The serialized Readium locator the engine can navigate to. */
  locator: string;
  /** Spine href of the locator's section (labels, annotation provenance). */
  chapterHref: string | null;
}

/**
 * Where the open book is right now, in the document's own coordinates.
 * EPUB locates a canonical locator (+ spine href for labels); PDF a 1-based
 * page (+ the reading anchor's in-page fraction). Exactly one format's
 * fields exist — the union is the format check.
 */
export type ReaderPosition =
  ({ format: "epub" } & EpubLocator) | { format: "pdf"; page: number; fraction: number };

export type EpubReaderPosition = Extract<ReaderPosition, { format: "epub" }>;
export type PdfReaderPosition = Extract<ReaderPosition, { format: "pdf" }>;

/**
 * A navigation destination. EPUB targets use the engine's own locator
 * grammar (a serialized Readium locator — TOC entries, bookmarks, and
 * search matches share it; legacy foliate CFIs are migrated on the fly);
 * PDF targets are 1-based pages.
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
    ? isBookmarkAtLocator(annotation, position.locator)
    : isBookmarkAtPage(annotation, position.page);
}

/** The annotation input that persists a bookmark at `position`. */
export function bookmarkInputFor(position: ReaderPosition) {
  if (position.format === "epub") {
    return { kind: "bookmark" as const, cfi: position.locator, chapterHref: position.chapterHref };
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

/**
 * Navigation target for a spine/TOC href: a minimal href locator the engine
 * resolves to that section's start (a `#fragment` rides along as the
 * locator's fragment location).
 */
export function epubHrefJump(href: string): ReaderJump {
  return { format: "epub", locator: JSON.stringify({ href }) };
}

/** Navigation target for an in-book search match, or null when unlocatable. */
export function jumpToSearchMatch(match: ReaderSearchMatch): ReaderJump | null {
  if (match.locator !== null) return { format: "epub", locator: match.locator };
  if (match.page !== null) return { format: "pdf", page: match.page };
  return null;
}

/**
 * Progress persistence mapping. The stored row is format-specific; each
 * reader validates/serializes through these pure helpers so the shared
 * persistence hook stays format-blind. Restore is engine-owned: the record
 * passes through untouched and the engine seam resolves it (Readium rows
 * deserialize directly, foliate rows convert through the migration
 * adapter's fallback hierarchy — docs/EPUB.md).
 */

/**
 * The persisted EPUB row validates into a restore record as-is, or null
 * when the row is not for this format (a PDF row). Resolution — including
 * the foliate→Readium migration — happens in the engine seam.
 */
export function parseEpubProgress(
  record: ReadingProgressRecord | null,
): ReadingProgressRecord | null {
  if (record === null) return null;
  const hasEpubLocator =
    (record.locator !== null && record.locator.trim() !== "") ||
    (record.cfi !== null && record.cfi.trim() !== "") ||
    (record.chapterHref !== null && record.chapterHref.trim() !== "");
  return hasEpubLocator ? record : null;
}

/** Schema version the Readium reader writes into converted progress rows. */
export const EPUB_PROGRESS_SCHEMA_VERSION = 2;

/** The locations JSON extracted from a serialized locator (or null). */
function locationsJson(locator: string): string | null {
  try {
    const parsed: unknown = JSON.parse(locator);
    if (parsed !== null && typeof parsed === "object") {
      const locations = (parsed as { locations?: unknown }).locations;
      if (locations !== undefined) return JSON.stringify(locations);
    }
  } catch {
    // A locator that fails to parse was already rejected by the engine.
  }
  return null;
}

/**
 * The wire payload for a Readium-era save: the canonical locator plus its
 * coarse totalProgression (`position` is the shell's 0–100 percent) and the
 * engine/schema markers that make the migration idempotent. The foliate-era
 * columns (`cfi`, `chapterHref`) are intentionally absent — the service
 * preserves them as provenance.
 */
export function epubProgressPayload(locator: EpubLocator, position: number): ReadingProgressInput {
  const progression = Math.min(Math.max(position / 100, 0), 1);
  return {
    locator: locator.locator,
    progression,
    locations: locationsJson(locator.locator),
    engine: "readium",
    schemaVersion: EPUB_PROGRESS_SCHEMA_VERSION,
    progressPercent: position,
  };
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
