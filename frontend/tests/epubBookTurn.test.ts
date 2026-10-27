import { describe, expect, it, vi } from "vite-plus/test";
import {
  createInstantEpubBookTurn,
  type EpubBookTurnHost,
} from "@/components/reader/epub/epubBookTurn";

/**
 * The instant turn adapter (tuxbooks-9pr.7, ADR 0011): advance/retreat
 * move the engine one spread and resolve with its settled locator, the
 * reduced-motion flag rides along, and the adapter never reads the media
 * query itself.
 */
describe("createInstantEpubBookTurn", () => {
  /** Stand-in for the engine's serialized locator of the settled spread. */
  const SETTLED_LOCATOR = '{"href":"chapter2.xhtml","locations":{"progression":0.4}}';

  function makeHost(overrides: Partial<EpubBookTurnHost> = {}) {
    const host: EpubBookTurnHost = {
      reducedMotion: false,
      move: vi.fn(async () => SETTLED_LOCATOR),
      ...overrides,
    };
    return { host, move: host.move };
  }

  it("advances by one spread and resolves with the settled locator", async () => {
    const { host, move } = makeHost();
    const turn = createInstantEpubBookTurn(host);

    await expect(turn.advance()).resolves.toBe(SETTLED_LOCATOR);
    expect(move).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledWith("next");
  });

  it("retreats by one spread and resolves with the settled locator", async () => {
    const { host, move } = makeHost();
    const turn = createInstantEpubBookTurn(host);

    await expect(turn.retreat()).resolves.toBe(SETTLED_LOCATOR);
    expect(move).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledWith("prev");
  });

  it("moves once per press, with no turn in flight to drop it against", async () => {
    const { host, move } = makeHost();
    const turn = createInstantEpubBookTurn(host);

    turn.advance();
    turn.advance();
    turn.retreat();
    await expect(turn.retreat()).resolves.toBe(SETTLED_LOCATOR);
    expect(move).toHaveBeenCalledTimes(4);
  });

  it("resolves null when the engine move fails", async () => {
    const { host } = makeHost({
      move: vi.fn(async () => {
        throw new Error("engine wedged");
      }),
    });

    const settled = createInstantEpubBookTurn(host).advance();
    await expect(settled).resolves.toBeNull();
  });

  it("carries the reduced-motion flag without ever reading the media query", () => {
    // A media query the adapter would trip over if it read one itself.
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(() => {
      throw new Error("the turn adapter must not read the media query");
    });
    try {
      const { host } = makeHost({ reducedMotion: true });
      const turn = createInstantEpubBookTurn(host);
      expect(turn.reducedMotion).toBe(true);
      // Stage 1 is instant either way; the flag is plumbing for the
      // Stage 2 renderer (tuxbooks-2ir).
      return expect(turn.advance()).resolves.toBe(SETTLED_LOCATOR);
    } finally {
      matchMedia.mockRestore();
    }
  });

  it("exposes the flag as false when the view reports no preference", () => {
    const { host } = makeHost({ reducedMotion: false });
    expect(createInstantEpubBookTurn(host).reducedMotion).toBe(false);
  });
});
