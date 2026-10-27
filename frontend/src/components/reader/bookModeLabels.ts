/**
 * Shared book-mode labels (tuxbooks-9pr review): the EPUB and PDF book
 * surfaces must read the same to assistive tech, and the E2E journey
 * asserts the same strings, so one module owns them — imported by both
 * readers, their zones, their tests, and e2e/specs/book-mode.e2e.ts.
 */

/**
 * Accessible name of the book spread surface: while book mode is on the
 * reading surface is a named region, announced the same way in both
 * readers.
 */
export const BOOK_SPREAD_LABEL = "Book spread";

/** Accessible names of the turn affordances (edge strips and corners). */
export const BOOK_TURN_LABELS = {
  prev: "Turn to the previous spread",
  next: "Turn to the next spread",
} as const;
