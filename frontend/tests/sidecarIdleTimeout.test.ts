// @vitest-environment node
import { afterEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RpcFailure, Sidecar } from "../../electron/main/sidecar";

/**
 * Idle-timeout semantics (tuxbooks bulk-forget nibble): a sidecar request
 * must survive past the idle window while the sidecar streams progress
 * events — a bulk Forget of a large history runs for minutes that way — and
 * must still fail when the sidecar goes silent. A total-deadline timeout
 * abandoned healthy bulk work mid-flight and left partial state behind.
 */

const FAKE_SIDECAR = `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "ping") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: "pong" }) + "\\n");
      continue;
    }
    if (process.env.FAKE_SIDECAR_MODE !== "streaming") continue;
    const timer = setInterval(() => {
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0", method: "event", params: { name: "progress", payload: Date.now() },
      }) + "\\n");
    }, 150);
    setTimeout(() => {
      clearInterval(timer);
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { done: true } }) + "\\n");
    }, 1200);
  }
});
`;

let scratch: string | null = null;

function writeFakeSidecar(mode: "streaming" | "silent"): string {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-idle-test-"));
  const scriptPath = path.join(scratch, "fake-sidecar.mjs");
  fs.writeFileSync(scriptPath, FAKE_SIDECAR);
  fs.chmodSync(scriptPath, 0o755);
  process.env.FAKE_SIDECAR_MODE = mode;
  return scriptPath;
}

afterEach(() => {
  process.env.FAKE_SIDECAR_MODE = "";
  if (scratch !== null) {
    fs.rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  }
});

describe("sidecar call idle timeout", () => {
  it("keeps a call alive past the idle window while progress events stream", async () => {
    const scriptPath = writeFakeSidecar("streaming");
    const transport = new Sidecar(scriptPath, () => {}, { idleTimeoutMs: 500 });

    await transport.start();
    const outcome = (await transport.call("slow")) as { done: boolean };
    transport.stop();

    expect(outcome).toEqual({ done: true });
  });

  it("rejects the call when the sidecar stays silent for the idle window", async () => {
    const scriptPath = writeFakeSidecar("silent");
    const transport = new Sidecar(scriptPath, () => {}, { idleTimeoutMs: 400 });

    await transport.start();
    await expect(transport.call("slow")).rejects.toThrow(RpcFailure);
    await expect(transport.call("slow")).rejects.toThrow(/timed out: slow/);
    transport.stop();
  });
});
