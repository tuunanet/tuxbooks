/**
 * Renderer console tail (crash survival): renderer and worker diagnostics
 * are lost the moment the renderer crashes, so main mirrors every console
 * message and replays the most recent ones when the process dies. Warnings
 * and errors are also echoed live — they are rare and usually the signal.
 * The buffer is small on purpose: enough to hold the operations in flight
 * (the engine logs one breadcrumb pair per worker request), never a log sink.
 *
 * Extracted from main/index.ts so the echo policy is unit-testable.
 */

/**
 * Browser-generated messages that arrive at error level but carry no fault.
 * Chromium logs these from its own ResizeObserver bookkeeping, outside any
 * page code, so the source is always the document URL at line 0.
 *
 * `ResizeObserver loop completed with undelivered notifications` is the
 * benign one: a resize settled one frame after the observer ran, and the
 * layout is correct afterwards. The EPUB reader produces it routinely —
 * Readium's snapper and decoration modules observe the content frames, and
 * opening/closing the reader resizes those frames faster than one frame can
 * deliver, so a session with several reader cycles logs it dozens of times.
 * It still goes into the crash buffer; only the live echo is suppressed.
 *
 * Deliberately not listed: `ResizeObserver loop limit exceeded`, which means
 * an observer is stuck in a genuine runaway loop. That one keeps echoing.
 */
const BENIGN_RENDERER_MESSAGES: readonly string[] = [
  "ResizeObserver loop completed with undelivered notifications",
];

/** True when a renderer console line is known browser noise, not a fault. */
export function isBenignRendererMessage(message: string): boolean {
  return BENIGN_RENDERER_MESSAGES.some((benign) => message.includes(benign));
}

/**
 * Whether a renderer console line is echoed live to the terminal. Errors
 * echo (they are usually the signal); warnings stay buffered for the crash
 * dump, since React logs many. Benign browser noise is treated like a
 * warning: buffered, never echoed.
 */
export function isEchoedLive(level: string, message: string): boolean {
  return level === "error" && !isBenignRendererMessage(message);
}

const RENDERER_CONSOLE_LIMIT = 200;
const RENDERER_CONSOLE_TAIL = 40;
const rendererConsole: string[] = [];

export interface RendererConsoleDetails {
  message: string;
  level: string;
  lineNumber: number;
  sourceId: string;
}

/** Mirror one renderer console line into the crash-survival buffer. */
export function recordRendererConsole(details: RendererConsoleDetails): void {
  const line = `[renderer:${details.level}] ${details.message} (${details.sourceId}:${details.lineNumber})`;
  rendererConsole.push(line);
  if (rendererConsole.length > RENDERER_CONSOLE_LIMIT) rendererConsole.shift();
  if (isEchoedLive(details.level, details.message)) console.error(line);
}

/**
 * Replay the buffered tail after a renderer death, then empty it. Returns
 * the lines that were replayed (empty when the buffer was already empty) so
 * callers can tell an empty buffer from a partial tail.
 */
export function replayRendererConsoleTail(): string[] {
  if (rendererConsole.length === 0) return [];
  const tail = rendererConsole.slice(-RENDERER_CONSOLE_TAIL);
  console.error(
    `[electron] last ${Math.min(rendererConsole.length, RENDERER_CONSOLE_TAIL)} renderer messages:`,
  );
  for (const line of tail) console.error(`  ${line}`);
  rendererConsole.length = 0;
  return tail;
}
