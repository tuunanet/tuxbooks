/**
 * Book-mode turn affordances for the EPUB surface (tuxbooks-9pr.7): an
 * edge strip per side plus a triangular bottom-corner zone per direction,
 * overlaid pointer-transparent except on the zones themselves so interior
 * clicks and text selection stay untouched. Chrome buttons, mirroring the
 * PDF book view's zones; which turn they trigger is the caller's adapter.
 */

import { BOOK_TURN_LABELS } from "../bookModeLabels";

type TurnDirection = keyof typeof BOOK_TURN_LABELS;

export function EpubBookTurnZones({
  advance,
  retreat,
}: {
  /** Turns one spread forward (the reading direction's next spread). */
  advance: () => void;
  /** Turns one spread back. */
  retreat: () => void;
}) {
  const onClick = (direction: TurnDirection) => (direction === "next" ? advance : retreat);
  const edgeStrip = (direction: TurnDirection) => (
    <button
      type="button"
      data-epub-book-turn-edge={direction}
      aria-label={BOOK_TURN_LABELS[direction]}
      className={`pointer-events-auto absolute inset-y-0 w-8 cursor-pointer hover:bg-foreground/10 ${
        direction === "next" ? "right-0" : "left-0"
      }`}
      onClick={onClick(direction)}
    />
  );
  const turnCorner = (direction: TurnDirection) => (
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
      onClick={onClick(direction)}
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
