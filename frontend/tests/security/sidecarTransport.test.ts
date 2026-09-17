import { describe, expect, it } from "vitest";

import { LineBuffer, serializeRequest } from "../../../electron/main/sidecarTransport";
import { MAX_SIDECAR_REQUEST_BYTES } from "../../../electron/shared/pathSchema";

describe("serializeRequest (T-6: request payloads bounded)", () => {
  it("serializes a JSON-RPC request line", () => {
    const line = serializeRequest(1, "ping", {});
    expect(JSON.parse(line)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
      params: {},
    });
  });

  it("rejects requests beyond the size cap before they are written", () => {
    const huge = { blob: "x".repeat(MAX_SIDECAR_REQUEST_BYTES) };
    expect(() => serializeRequest(1, "import_paths", huge)).toThrow(/too large/);
  });
});

describe("LineBuffer (T-6: response lines bounded)", () => {
  it("splits chunks into complete lines and buffers partials", () => {
    const buffer = new LineBuffer(1024);
    expect(buffer.push('{"id":1}\n{"id":')).toEqual(['{"id":1}']);
    expect(buffer.push("2}\n")).toEqual(['{"id":2}']);
  });

  it("drops a complete over-cap line without disturbing the framing", () => {
    const buffer = new LineBuffer(16);
    const giant = "x".repeat(64);
    expect(buffer.push(`${giant}\nok\n`)).toEqual(["ok"]);
  });

  it("discards an accumulating over-cap line and resumes after its newline", () => {
    const buffer = new LineBuffer(16);
    expect(buffer.push("y".repeat(64))).toEqual([]);
    expect(buffer.push("still the discarded line\nok\n")).toEqual(["ok"]);
  });

  it("accepts lines exactly at the cap", () => {
    const buffer = new LineBuffer(8);
    expect(buffer.push("12345678\nz\n")).toEqual(["12345678", "z"]);
  });
});
