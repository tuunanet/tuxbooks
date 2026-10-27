import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createRotationEpubBookTurn,
  EPUB_TURN_PHASE_MS,
  type EpubBookTurnHost,
} from "@/components/reader/epub/epubBookTurn";

describe("createRotationEpubBookTurn", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeHost(overrides: Partial<EpubBookTurnHost> = {}) {
    const phases: Array<[string, string]> = [];
    const host: EpubBookTurnHost = {
      reducedMotion: false,
      move: vi.fn(async () => {}),
      setPhase: (phase, direction) => {
        phases.push([phase, direction]);
      },
      ...overrides,
    };
    return { host, phases };
  }

  it("rotates the current spread out, swaps, then rotates the new spread in", async () => {
    const { host, phases } = makeHost();
    const turn = createRotationEpubBookTurn(host);

    turn.advance();
    // Phase one starts immediately: the current spread rotates out.
    expect(phases).toEqual([["out", "next"]]);
    expect(host.move).not.toHaveBeenCalled();

    // The engine swap lands while the surface is edge-on…
    await vi.advanceTimersByTimeAsync(EPUB_TURN_PHASE_MS);
    expect(host.move).toHaveBeenCalledWith("next");
    // …and the new spread rotates in.
    expect(phases).toEqual([
      ["out", "next"],
      ["in", "next"],
    ]);

    await vi.advanceTimersByTimeAsync(EPUB_TURN_PHASE_MS);
    expect(phases).toEqual([
      ["out", "next"],
      ["in", "next"],
      ["idle", "next"],
    ]);
  });

  it("retreats backward through the mirrored phases", async () => {
    const { host, phases } = makeHost();
    const turn = createRotationEpubBookTurn(host);

    turn.retreat();
    await vi.advanceTimersByTimeAsync(EPUB_TURN_PHASE_MS * 2);
    expect(host.move).toHaveBeenCalledWith("prev");
    expect(phases).toEqual([
      ["out", "prev"],
      ["in", "prev"],
      ["idle", "prev"],
    ]);
  });

  it("swaps the spread instantly under reduced motion, with no phases", () => {
    const { host, phases } = makeHost({ reducedMotion: true });
    const turn = createRotationEpubBookTurn(host);
    expect(turn.reducedMotion).toBe(true);

    turn.advance();
    expect(host.move).toHaveBeenCalledWith("next");
    expect(phases).toEqual([]);
    // No timer pending: nothing to advance.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never reads the reduced-motion media query itself", () => {
    const matchMedia = vi.spyOn(window, "matchMedia").mockImplementation(() => {
      throw new Error("the turn adapter must not read the media query");
    });
    try {
      const { host } = makeHost({ reducedMotion: true });
      createRotationEpubBookTurn(host).advance();
      expect(host.move).toHaveBeenCalledWith("next");
    } finally {
      matchMedia.mockRestore();
    }
  });

  it("ignores presses while an animated turn is in flight", async () => {
    const { host } = makeHost();
    const turn = createRotationEpubBookTurn(host);

    turn.advance();
    turn.advance();
    turn.retreat();
    await vi.advanceTimersByTimeAsync(EPUB_TURN_PHASE_MS * 2);
    expect(host.move).toHaveBeenCalledTimes(1);
  });

  it("returns the surface to idle even when the engine move fails", async () => {
    const { host, phases } = makeHost({
      move: vi.fn(async () => {
        throw new Error("engine wedged");
      }),
    });
    createRotationEpubBookTurn(host).advance();

    await vi.advanceTimersByTimeAsync(EPUB_TURN_PHASE_MS * 2);
    expect(phases).toEqual([
      ["out", "next"],
      ["in", "next"],
      ["idle", "next"],
    ]);
  });

  it("reports a false reduced-motion flag when the view read it as off", () => {
    const { host } = makeHost();
    expect(createRotationEpubBookTurn(host).reducedMotion).toBe(false);
  });
});
