import "./epubBookTurn.css";

/**
 * The EPUB turn adapter seam (tuxbooks-9pr.7, spec tuxbooks-9pr → Turn
 * adapter): book mode asks it to advance or retreat by one spread, and
 * whatever renders the turn does the rest. The spread itself is the
 * engine's — in paginated flow at two columns one `goForward`/`goBackward`
 * is exactly one spread, so unlike the PDF side there is no grouping rule
 * to compute here (layoutSpread stays the single home of that rule, in
 * the PDF namespace).
 *
 * The adapter carries the reduced-motion flag the view read from the
 * media query; it never reads the query itself, so tests and the
 * playground can drive it deterministically. Stage 1 rotates the surface
 * in two phases (rotate the current spread out, swap, rotate the new one
 * in); a later stage can swap in a different renderer behind the same
 * interface.
 */
export interface EpubBookTurnAdapter {
  /**
   * The reduced-motion flag the view read from the media query and
   * passed in. The adapter itself never reads the media query — the view
   * owns that preference.
   */
  readonly reducedMotion: boolean;
  /** Turns forward one spread. */
  advance(): void;
  /** Turns back one spread. */
  retreat(): void;
}

/** Which way a turn goes; mirrors the zone direction attributes. */
export type EpubTurnDirection = "next" | "prev";

/**
 * The surface's turn phase: `out` rotates the current spread away, the
 * swap lands while it is edge-on, `in` rotates the new spread back to
 * rest, `idle` is settled. Published as `data-epub-turn-phase` on the
 * reading surface, which styles the matching keyframes.
 */
export type EpubTurnPhase = "idle" | "out" | "in";

/** What the rotation adapter needs from its host to turn a spread. */
export interface EpubBookTurnHost {
  /** Moves the engine one spread; resolves when the new spread is in place. */
  move: (direction: EpubTurnDirection) => Promise<void>;
  /** Drives the surface's rotation phase (see `EpubTurnPhase`). */
  setPhase: (phase: EpubTurnPhase, direction: EpubTurnDirection) => void;
  /**
   * Reduced-motion preference as the view read it. Under it the turn is
   * the plain engine swap — no phases, no timers.
   */
  reducedMotion: boolean;
}

/** Duration of each rotation phase; the surface's keyframes match it. */
export const EPUB_TURN_PHASE_MS = 240;

/**
 * Stage 1's rotation turn adapter (tuxbooks-9pr.7): one press runs the
 * two-phase turn around the engine swap. Under reduced motion it is the
 * bare swap — the instant path and the animated path are the same call
 * surface, per the spec's turn-adapter decision. Presses during an
 * animated turn are dropped rather than queued.
 */
export function createRotationEpubBookTurn(host: EpubBookTurnHost): EpubBookTurnAdapter {
  let turning = false;
  const turn = (direction: EpubTurnDirection): void => {
    if (host.reducedMotion) {
      host.move(direction).catch(() => {});
      return;
    }
    if (turning) return;
    turning = true;
    void (async () => {
      try {
        host.setPhase("out", direction);
        await wait(EPUB_TURN_PHASE_MS);
        // The engine swap lands while the surface is edge-on; a failed
        // move still rotates back in, so the reader never sticks mid-turn.
        await host.move(direction).catch(() => {});
        host.setPhase("in", direction);
        await wait(EPUB_TURN_PHASE_MS);
      } finally {
        host.setPhase("idle", direction);
        turning = false;
      }
    })();
  };
  return {
    reducedMotion: host.reducedMotion,
    advance: () => turn("next"),
    retreat: () => turn("prev"),
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
