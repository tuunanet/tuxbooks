import { describe, expect, it, vi } from "vite-plus/test";
import { createInstantPdfBookTurn } from "@/components/reader/pdf/pdfBookTurn";

/**
 * The Stage 1 turn adapter (tuxbooks-9pr.5): advance/retreat step by
 * spread through the pdfLayout closed forms, the host receives the
 * settled spread as its anchor page, and the reduced-motion flag rides
 * along without the adapter ever reading the media query.
 */
describe("createInstantPdfBookTurn", () => {
  /**
   * A host wired the way the real one is: a settle moves the position,
   * which comes back as the next call's current page.
   */
  function makeTurn(currentPage: number, pageCount: number, reducedMotion = false) {
    const host = {
      currentPage,
      pageCount,
      reducedMotion,
      onSettle: vi.fn((page: number) => {
        host.currentPage = page;
      }),
    };
    return { host, turn: createInstantPdfBookTurn(host), onSettle: host.onSettle };
  }

  it("turns the cover forward to the first facing spread", () => {
    const { turn, onSettle } = makeTurn(1, 6);
    // The cover is the first spread: there is nothing to retreat to.
    turn.retreat();
    expect(onSettle).not.toHaveBeenCalled();
    turn.advance();
    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledWith(2);
  });

  it("advances one spread per press and stops at the last one", () => {
    const { turn, onSettle } = makeTurn(2, 6);
    // From the first page of a pair (the old two-press bug: page 2 landed
    // on page 3 inside the same spread) one press reaches spread [4,5].
    turn.advance();
    expect(onSettle).toHaveBeenLastCalledWith(4);
    // From the second page of a pair, also one press.
    turn.advance();
    expect(onSettle).toHaveBeenLastCalledWith(6);
    // The last spread [6]: stay put, no wrap, no settle.
    turn.advance();
    expect(onSettle).toHaveBeenCalledTimes(2);
  });

  it("retreats to the previous spread's last page and stops at the cover", () => {
    const { turn, onSettle } = makeTurn(5, 6);
    // From the second page of a pair.
    turn.retreat();
    expect(onSettle).toHaveBeenLastCalledWith(3);
    // From the first page of a pair: one press back again, onto the
    // cover (the first spread's last page).
    turn.retreat();
    expect(onSettle).toHaveBeenLastCalledWith(1);
    // The cover is the first spread: stay put, no settle.
    turn.retreat();
    turn.retreat();
    expect(onSettle).toHaveBeenCalledTimes(2);
  });

  it("keeps a one-page document in place", () => {
    const { turn, onSettle } = makeTurn(1, 1);
    turn.advance();
    turn.retreat();
    expect(onSettle).not.toHaveBeenCalled();
  });

  it("carries the reduced-motion flag and settles instantly under it", () => {
    // A media query the adapter would trip over if it read one itself.
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(() => {
      throw new Error("the turn adapter must not read the media query");
    });
    try {
      const { turn, onSettle } = makeTurn(2, 6, true);
      expect(turn.reducedMotion).toBe(true);
      // Stage 1 is instant either way; the flag is plumbing for later
      // animated stages.
      turn.advance();
      expect(onSettle).toHaveBeenCalledWith(4);
    } finally {
      matchMedia.mockRestore();
    }
  });

  it("exposes the flag as false when the view reports no preference", () => {
    const { turn } = makeTurn(1, 3, false);
    expect(turn.reducedMotion).toBe(false);
  });
});
