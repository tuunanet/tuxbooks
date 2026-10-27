/**
 * Book-mode turn affordances for the EPUB surface (tuxbooks-9pr.7): an
 * edge strip per side plus a triangular bottom-corner zone per direction,
 * overlaid pointer-transparent except on the zones themselves so interior
 * clicks and text selection stay untouched. Chrome buttons, mirroring the
 * PDF book view's zones; the caller routes each direction through its
 * turn path (the reader's adapter in book mode).
 */

import { BOOK_TURN_LABELS } from "../bookModeLabels";
import type { EpubTurnDirection } from "./epubBookTurn";

export function EpubBookTurnZones({
  turn,
}: {
  /** Turns one spread in the given direction ("next" is the reading direction). */
  turn: (direction: EpubTurnDirection) => void;
}) {
  const edgeStrip = (direction: EpubTurnDirection) => (
    <button
      type="button"
      data-epub-book-turn-edge={direction}
      aria-label={BOOK_TURN_LABELS[direction]}
      className={`pointer-events-auto absolute inset-y-0 w-8 cursor-pointer hover:bg-foreground/10 ${
        direction === "next" ? "right-0" : "left-0"
      }`}
      onClick={() => turn(direction)}
    />
  );
  const turnCorner = (direction: EpubTurnDirection) => (
    <button
      type="button"
      data-epub-book-turn-corner={direction}
      aria-label={BOOK_TURN_LABELS[direction]}
      className={`pointer-events-auto absolute bottom-0 h-[72px] w-[72px] cursor-pointer hover:bg-foreground/10 ${
        direction === "next" ? "right-0" : "left-0"
      }`}
      style={{
        clipPath:
          direction === "next"
            ? "polygon(100% 0, 100% 100%, 0 100%)"
            : "polygon(0 0, 0 100%, 100% 100%)",
      }}
      onClick={() => turn(direction)}
    />
  );
  return (
    <div data-testid="epub-book-turn-zones" className="pointer-events-none absolute inset-0">
      {edgeStrip("prev")}
      {edgeStrip("next")}
      {turnCorner("prev")}
      {turnCorner("next")}
    </div>
  );
}
