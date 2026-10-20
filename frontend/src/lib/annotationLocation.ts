import type { Annotation } from "@/types/domain";

/** Maximum bookmark label length, in Unicode characters. */
export const BOOKMARK_LABEL_MAX = 50;

/** Caps a draft label by code points so non-ASCII text is not cut early. */
export function clampBookmarkLabel(value: string): string {
  return Array.from(value).slice(0, BOOKMARK_LABEL_MAX).join("");
}

/**
 * A readable location for an annotation when no table of contents is loaded.
 * PDF annotations carry a page number; EPUB annotations carry a spine href,
 * which is shortened to a human-readable chapter stem.
 */
export function annotationLocationLabel(annotation: Annotation): string {
  if (annotation.pageNumber !== null) return `Page ${annotation.pageNumber}`;
  if (annotation.chapterHref) {
    const path = annotation.chapterHref.split("#")[0] ?? annotation.chapterHref;
    const file = path.split("/").pop() ?? path;
    const stem = file
      .replace(/\.[^.]+$/, "")
      .replaceAll(/[-_]+/g, " ")
      .trim();
    if (stem !== "") return stem.charAt(0).toUpperCase() + stem.slice(1);
  }
  return annotation.kind === "bookmark" ? "Bookmark" : "Highlight";
}

/** In-chapter and book-wide progress carried by an EPUB bookmark locator. */
export interface BookmarkProgress {
  /** Position inside the current chapter, 0..1. */
  fraction: number;
  /** Position in the whole book, 0..1, when the locator reports it. */
  total: number | null;
}

function unitFraction(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

/**
 * Reads the position out of the stored Readium locator. Legacy foliate CFIs
 * and malformed JSON have no progression, so they report null instead of a
 * guessed percentage.
 */
export function bookmarkProgress(annotation: Annotation): BookmarkProgress | null {
  if (annotation.kind !== "bookmark" || annotation.cfi === null) return null;
  try {
    const locator = JSON.parse(annotation.cfi) as {
      locations?: { progression?: unknown; totalProgression?: unknown };
    };
    const fraction = unitFraction(locator.locations?.progression);
    if (fraction === null) return null;
    return { fraction, total: unitFraction(locator.locations?.totalProgression) };
  } catch {
    return null;
  }
}

/** `37% through chapter`, or null when the bookmark has no progression. */
export function bookmarkProgressLabel(annotation: Annotation): string | null {
  const progress = bookmarkProgress(annotation);
  return progress === null ? null : `${Math.round(progress.fraction * 100)}% through chapter`;
}

/**
 * `Chapter 2 · 37%` (or `Page 7`) for bookmark rows. `baseLabel` lets the
 * reader drawer substitute its richer TOC label.
 */
export function bookmarkLocationAndProgress(
  annotation: Annotation,
  baseLabel: string = annotationLocationLabel(annotation),
): string {
  const progress = bookmarkProgressLabel(annotation);
  return progress === null ? baseLabel : `${baseLabel} · ${progress}`;
}

/** The user label when set, otherwise the location plus in-chapter progress. */
export function bookmarkTitle(annotation: Annotation): string {
  const label = annotation.label?.trim();
  return label ? label : bookmarkLocationAndProgress(annotation);
}

/** Deterministic saved-at text for details rows. */
export function bookmarkSavedLabel(annotation: Annotation): string {
  return `Saved ${new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(annotation.createdAt))}`;
}
