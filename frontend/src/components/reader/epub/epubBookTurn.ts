/**
 * The EPUB turn adapter seam (tuxbooks-9pr.7, spec tuxbooks-9pr → Turn
 * adapter): book mode asks it to advance or retreat by one spread, and
 * the engine move is the turn — each call resolves with the settled
 * spread's locator, the report-back the PDF adapter does through its
 * onSettle host. The spread itself is the engine's — in paginated flow at
 * two columns one `goForward`/`goBackward` is exactly one spread, so
 * unlike the PDF side there is no grouping rule to compute here
 * (layoutSpread stays the single home of that rule, in the PDF
 * namespace).
 *
 * The adapter carries the reduced-motion flag the view read from the
 * media query; it never reads the query itself, so tests and the
 * playground can drive it deterministically. The Stage 1 rotation turn
 * was dropped after UAT (ADR 0011); the spread change is instant, reduced
 * motion or not. A later animated stage swaps in behind the same
 * interface (tuxbooks-2ir) and needs that flag wired.
 */
export interface EpubBookTurnAdapter {
  /**
   * The reduced-motion flag the view read from the media query and
   * passed in. The adapter itself never reads the media query — the view
   * owns that preference.
   */
  readonly reducedMotion: boolean;
  /**
   * Turns forward one spread; resolves with the settled spread's locator
   * (null when the engine cannot name one or the move failed).
   */
  advance(): Promise<string | null>;
  /** Turns back one spread; resolves with the settled spread's locator. */
  retreat(): Promise<string | null>;
}

/** Which way a turn goes; mirrors the zone direction attributes. */
export type EpubTurnDirection = "next" | "prev";

/** What the instant adapter needs from its host to turn a spread. */
export interface EpubBookTurnHost {
  /**
   * Moves the engine one spread; resolves with the settled locator (the
   * position the move landed on, or null when the engine cannot name
   * one). This is the adapter's settlement report — the EPUB twin of the
   * PDF adapter's onSettle (spec → Turn adapter).
   */
  move: (direction: EpubTurnDirection) => Promise<string | null>;
  /**
   * Reduced-motion preference as the view read it. The turn settles
   * instantly either way; the flag rides along for stages that animate
   * (tuxbooks-2ir).
   */
  reducedMotion: boolean;
}

/**
 * The instant turn adapter (tuxbooks-9pr.7, ADR 0011): one press is one
 * engine move by one spread, settled as soon as the engine settles — no
 * transition, reduced motion or not. A failed move settles nothing: the
 * turn resolves null.
 */
export function createInstantEpubBookTurn(host: EpubBookTurnHost): EpubBookTurnAdapter {
  const turn = (direction: EpubTurnDirection): Promise<string | null> =>
    host.move(direction).catch(() => null);
  return {
    reducedMotion: host.reducedMotion,
    advance: () => turn("next"),
    retreat: () => turn("prev"),
  };
}
