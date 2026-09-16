import { MAX_SIDECAR_REQUEST_BYTES } from "../shared/pathSchema";

/**
 * Transport primitives for the sidecar JSON-RPC channel (issue #84 T-6):
 * request serialization with a size bound, and newline framing with a
 * response-line bound. Pure and unit-testable; `Sidecar` composes them.
 *
 * An over-cap response line is discarded, never buffered: the pending caller
 * surfaces its timeout instead of letting a runaway peer grow main-process
 * memory without bound.
 */

/** Serialize one JSON-RPC request line, rejecting oversized payloads. */
export function serializeRequest(
  id: number,
  method: string,
  params: Record<string, unknown>,
): string {
  const request = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  if (request.length > MAX_SIDECAR_REQUEST_BYTES) {
    throw new Error(`request too large: ${method}`);
  }
  return request;
}

/** Newline framing with a per-line cap. Over-cap lines are dropped whole. */
export class LineBuffer {
  private buffer = "";
  private overflowing = false;

  constructor(private readonly maxLineLength: number) {}

  /** Append a decoded chunk; returns the complete lines it finished. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    for (;;) {
      if (this.overflowing) {
        const newline = this.buffer.indexOf("\n");
        if (newline === -1) {
          if (this.buffer.length > this.maxLineLength) this.buffer = "";
          return lines;
        }
        this.buffer = this.buffer.slice(newline + 1);
        this.overflowing = false;
        continue;
      }
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        if (this.buffer.length > this.maxLineLength) {
          this.buffer = "";
          this.overflowing = true;
        }
        return lines;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > this.maxLineLength) continue;
      lines.push(line);
    }
  }
}
