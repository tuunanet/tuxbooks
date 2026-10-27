import { nextSpreadPageIndex, previousSpreadPageIndex } from "./pdfLayout";

/**
 * The turn adapter seam (tuxbooks-9pr.5): book mode asks it to advance or
 * retreat by one spread and receives the settled spread through its host.
 * The shell's keyboard and the view's edge/corner zones both call the same
 * registered instance, so every turn settles through one path. Stage 1's
 * implementation is instant (below); a later animated stage swaps in behind
 * the same interface.
 */
export interface PdfBookTurnAdapter {
  /**
   * The reduced-motion flag the book view read from the media query and
   * passed in. The adapter itself never reads the media query — the view
   * owns that preference.
   */
  readonly reducedMotion: boolean;
  /** Turns forward one spread; the host applies the settled spread. */
  advance(): void;
  /** Turns back one spread; the host applies the settled spread. */
  retreat(): void;
}

/** What the instant adapter needs from its host to settle a turn. */
export interface PdfBookTurnHost {
  /**
   * The 1-based page the reading position currently names. Every spread is
   * uniquely identified by its first page under layoutSpread's grouping, so
   * this names the current spread.
   */
  currentPage: number;
  /** The document's page count. */
  pageCount: number;
  /**
   * Reduced-motion preference as the view read it. Stage 1 settles
   * instantly either way; the flag rides along for stages that animate.
   */
  reducedMotion: boolean;
  /**
   * Applies the settled spread: moves the reading position to the spread's
   * first page (the anchor). Called only when a turn actually lands on a
   * different spread — the ends of the document stay put without a call.
   */
  onSettle: (pageNumber: number) => void;
}

/**
 * Stage 1's instant turn adapter (tuxbooks-9pr): one press steps by
 * spread through the pdfLayout closed forms and settles immediately — no
 * transition, reduced motion or not. The target is computed per call from
 * the host's current page, so a press always sees the latest position.
 */
export function createInstantPdfBookTurn(host: PdfBookTurnHost): PdfBookTurnAdapter {
  const turn = (targetFor: (pageIndex: number, pageCount: number) => number) => {
    if (host.pageCount <= 0) return;
    const current = Math.min(Math.max(1, host.currentPage), host.pageCount);
    const target = targetFor(current - 1, host.pageCount);
    if (target === current - 1) return;
    host.onSettle(target + 1);
  };
  return {
    reducedMotion: host.reducedMotion,
    advance: () => turn(nextSpreadPageIndex),
    retreat: () => turn(previousSpreadPageIndex),
  };
}
