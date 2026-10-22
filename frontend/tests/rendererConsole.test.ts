import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  isBenignRendererMessage,
  isEchoedLive,
  recordRendererConsole,
  replayRendererConsoleTail,
} from "../../electron/main/rendererConsole";

/**
 * Renderer console echo policy (data-management spec): the terminal only
 * mirrors renderer errors live, because a crash dump already keeps every
 * buffered line. Chromium logs one ResizeObserver message at error level on
 * every EPUB reader open/close cycle — benign, and the reason a normal
 * reading session used to spray the terminal with "[renderer:error]". It is
 * downgraded to buffered-only; every other error keeps echoing, including
 * the genuinely bad ResizeObserver message.
 */

// Chromium's benign ResizeObserver message, verbatim as it reaches
// console-message. The source is always the document URL at line 0, since
// the browser logs it rather than any page code.
const BENIGN_RO =
  "ResizeObserver loop completed with undelivered notifications. (app://bundle/index.html:0)";
// A different ResizeObserver fault that must keep echoing: an observer is
// stuck in a real runaway loop and hit its depth cap.
const RUNAWAY_RO = "ResizeObserver loop limit exceeded. (app://bundle/index.html:0)";

// Captured live echoes: each entry is the argument list one console.error
// received. The buffer is module state, so each test drains it first.
let echoed: unknown[][];

beforeEach(() => {
  echoed = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    echoed.push(args);
  });
  // Each test starts from an empty buffer: replay whatever a prior test left.
  replayRendererConsoleTail();
  echoed.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderer console echo policy", () => {
  it("classifies the benign ResizeObserver message and nothing close to it", () => {
    expect(isBenignRendererMessage(BENIGN_RO)).toBe(true);
    // Unprefixed, so the classifier does not depend on the trailing source.
    expect(
      isBenignRendererMessage("ResizeObserver loop completed with undelivered notifications"),
    ).toBe(true);
    // The runaway-loop variant is a real fault, not noise.
    expect(isBenignRendererMessage(RUNAWAY_RO)).toBe(false);
    expect(isBenignRendererMessage("TypeError: undefined is not a function")).toBe(false);
    expect(isBenignRendererMessage("")).toBe(false);
  });

  it("buffers the benign message without echoing it", () => {
    recordRendererConsole({
      message: "ResizeObserver loop completed with undelivered notifications.",
      level: "error",
      lineNumber: 0,
      sourceId: "app://bundle/index.html",
    });
    expect(echoed).toEqual([]);
    // Still buffered: a renderer crash must replay it.
    expect(replayRendererConsoleTail()).toHaveLength(1);
  });

  it("echoes every other error, including the runaway ResizeObserver message", () => {
    recordRendererConsole({
      message: "ResizeObserver loop limit exceeded.",
      level: "error",
      lineNumber: 0,
      sourceId: "app://bundle/index.html",
    });
    recordRendererConsole({
      message: "TypeError: undefined is not a function",
      level: "error",
      lineNumber: 12,
      sourceId: "http://localhost:1420/src/lib/bridge.ts",
    });
    expect(echoed).toHaveLength(2);
    expect(String(echoed[0]![0])).toContain("ResizeObserver loop limit exceeded");
    expect(String(echoed[1]![0])).toContain("TypeError: undefined is not a function");
  });

  it("keeps warnings buffered, matching the noise floor for React logs", () => {
    recordRendererConsole({
      message: "Warning: Each child in a list should have a unique key.",
      level: "warning",
      lineNumber: 0,
      sourceId: "http://localhost:1420/assets/index.js",
    });
    expect(echoed).toEqual([]);
    expect(replayRendererConsoleTail()).toHaveLength(1);
  });

  it("replays the buffered tail in order and empties the buffer", () => {
    recordRendererConsole({
      message: "ResizeObserver loop completed with undelivered notifications.",
      level: "error",
      lineNumber: 0,
      sourceId: "app://bundle/index.html",
    });
    recordRendererConsole({
      message: "first real error",
      level: "error",
      lineNumber: 1,
      sourceId: "app://bundle/index.html",
    });
    const tail = replayRendererConsoleTail();
    expect(tail).toHaveLength(2);
    expect(tail[0]).toContain("ResizeObserver loop completed");
    expect(tail[1]).toContain("first real error");
    // The replay itself prints the tail, then the buffer is empty.
    expect(replayRendererConsoleTail()).toEqual([]);
  });

  it("surfaces the live-echo decision directly for callers", () => {
    expect(
      isEchoedLive("error", "ResizeObserver loop completed with undelivered notifications."),
    ).toBe(false);
    expect(isEchoedLive("error", "ResizeObserver loop limit exceeded.")).toBe(true);
    expect(isEchoedLive("warning", "anything")).toBe(false);
    expect(isEchoedLive("log", "anything")).toBe(false);
  });
});
