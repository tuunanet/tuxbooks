import type { EpubTocItem } from "@/lib/epub/readiumEngine";
import type { PdfOutlineItem } from "@/lib/pdf/pdfEngine";
import type { ReaderPosition } from "../readerModel";

/**
 * Reader-reported data is tagged with the book it belongs to, so a stale
 * book's TOC, outline, or position is never shown. These pick the value for
 * the open book and drop everything else.
 */
export function tocForBook(
  state: { bookId: number; toc: EpubTocItem[] } | null,
  bookId: number | undefined,
): EpubTocItem[] | null {
  if (state === null || state.bookId !== bookId) return null;
  return state.toc;
}

export function outlineForBook(
  state: { bookId: number; outline: PdfOutlineItem[] } | null,
  bookId: number | undefined,
): PdfOutlineItem[] | null {
  if (state === null || state.bookId !== bookId) return null;
  return state.outline;
}

export function positionForBook(
  state: { bookId: number; position: ReaderPosition } | null,
  bookId: number | undefined,
): ReaderPosition | null {
  if (state === null || state.bookId !== bookId) return null;
  return state.position;
}

/** The `data-*-presentation` marker, or nothing when that mode is off. */
export function presentationFlag(
  active: boolean | undefined,
  presentation: boolean,
): "true" | undefined {
  return active && presentation ? "true" : undefined;
}
