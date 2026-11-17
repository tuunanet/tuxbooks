import { useCallback, type RefObject } from "react";
import { useShortcut } from "@/lib/shortcuts";
import type { PdfBookTurnAdapter } from "../pdf/pdfBookTurn";
import { pageToPosition, positionToPage } from "../pdf/pdfPages";

interface UseReaderPagingInput {
  isPdf: boolean;
  presentation: boolean;
  bookMode: boolean;
  position: number;
  setPosition: (position: number) => void;
  pdfPageCount: number | null;
  pdfPageCountPlaceholder: number;
  bookTurnRef: RefObject<PdfBookTurnAdapter | null>;
}

export interface ReaderPaging {
  pdfPageStep: (delta: 1 | -1) => void;
  pdfModeStep: (delta: 1 | -1) => boolean;
}

/**
 * PDF page stepping and book-mode spread turns. A one-page step inside a
 * two-page spread is an invisible move, the two-press feel the mode exists to
 * fix, so book mode goes through the registered turn adapter when it exists.
 */
export function useReaderPaging({
  isPdf,
  presentation,
  bookMode,
  position,
  setPosition,
  pdfPageCount,
  pdfPageCountPlaceholder,
  bookTurnRef,
}: UseReaderPagingInput): ReaderPaging {
  const pageCount = isPdf ? (pdfPageCount ?? pdfPageCountPlaceholder) : 0;
  // Percentage stepping needs a known page count; EPUB owns these keys instead.
  const step = pageCount > 0 ? 100 / pageCount : 0;

  useShortcut("home", () => setPosition(0));
  useShortcut("end", () => setPosition(100));

  // PDF steps are page-based: percentage stepping accumulates rounding error, so a
  // flip always lands on the adjacent page; without a page count it is the fallback.
  const flipPdfPage = useCallback(
    (delta: 1 | -1) => {
      const count = pdfPageCount ?? 0;
      if (count <= 0) {
        setPosition(position + delta * step);
        return;
      }
      const page = positionToPage(position, count);
      const next = Math.max(1, Math.min(count, page + delta));
      setPosition(pageToPosition(next, count));
    },
    [pdfPageCount, position, setPosition, step],
  );

  // Book mode steps by SPREAD via the registered turn adapter: a one-page step
  // inside a spread is invisible. With no adapter yet (view still mounting),
  // fall back to page stepping and let the mounted spread render the position.
  const bookTurn = useCallback(
    (delta: 1 | -1) => {
      const turn = bookTurnRef.current;
      if (turn) {
        if (delta === 1) turn.advance();
        else turn.retreat();
        return;
      }
      flipPdfPage(delta);
    },
    [bookTurnRef, flipPdfPage],
  );

  // Every stepping key shares this: presentation flips pages, book turns spreads, scroll falls through.
  const pdfModeStep = useCallback(
    (delta: 1 | -1): boolean => {
      if (!isPdf) return false;
      if (presentation) {
        flipPdfPage(delta);
        return true;
      }
      if (bookMode) {
        bookTurn(delta);
        return true;
      }
      return false;
    },
    [bookMode, bookTurn, flipPdfPage, isPdf, presentation],
  );

  const pdfPageStep = useCallback(
    (delta: 1 | -1) => {
      if (pdfModeStep(delta)) return;
      if (!isPdf) {
        setPosition(position + delta * step);
        return;
      }
      flipPdfPage(delta);
    },
    [flipPdfPage, isPdf, pdfModeStep, position, setPosition, step],
  );

  return { pdfPageStep, pdfModeStep };
}
