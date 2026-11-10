// @vitest-environment node
import { afterEach, describe, expect, it } from "vite-plus/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { RpcFailure, Sidecar } from "../../electron/main/sidecar";

/**
 * Idle-timeout semantics (tuxbooks bulk-forget nibble, tuxbooks-9zh import):
 * a sidecar request must survive past the idle window while the sidecar
 * streams progress events — a bulk Forget of a large history or a 10k-book
 * folder import runs for minutes that way — and must still fail when the
 * sidecar goes silent. A total-deadline timeout abandoned healthy bulk work
 * mid-flight and left partial state behind.
 */

const FAKE_SIDECAR = `#!/usr/bin/env node
process.stdin.setEncoding("utf8");
let buf = "";
let hangId = null;
const respond = (id, result) => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
};
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === "ping") {
      respond(msg.id, "pong");
      continue;
    }
    const mode = process.env.FAKE_SIDECAR_MODE;
    const idleMs = Number(process.env.FAKE_SIDECAR_IDLE_MS);
    // "streaming" emits densely (150 ms); "sparse" derives its cadence from
    // the configured window — events at half of it across a three-window
    // span, the geometry a real bulk import guarantees (per-book parse
    // budget <= 30 s against a 60 s window).
    if (mode === "streaming" || mode === "sparse") {
      const everyMs = mode === "sparse" ? idleMs / 2 : 150;
      const totalMs = mode === "sparse" ? idleMs * 3 : 1200;
      const timer = setInterval(() => {
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0", method: "event", params: { name: "progress", payload: Date.now() },
        }) + "\\n");
      }, everyMs);
      setTimeout(() => {
        clearInterval(timer);
        respond(msg.id, { done: true });
      }, totalMs);
      continue;
    }
    // "interleaved": the first call never gets a direct answer until a later
    // unrelated call's response — traffic from one call re-arms another's
    // guard (the documented global-liveness tradeoff). The hang's answer
    // lands 750 ms after the poke's response, past the window the call was
    // armed with, so only a re-arm from that response can resolve it.
    if (mode === "interleaved") {
      if (msg.method === "hang") {
        hangId = msg.id;
        continue;
      }
      if (msg.method === "poke") {
        respond(msg.id, { poked: true });
        setTimeout(() => respond(hangId, { done: true }), 750);
        continue;
      }
    }
  }
});
`;

let scratch: string | null = null;
let active: Sidecar | null = null;

function writeFakeSidecar(
  mode: "streaming" | "sparse" | "interleaved" | "silent",
  idleMs: number,
): string {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-idle-test-"));
  const scriptPath = path.join(scratch, "fake-sidecar.mjs");
  fs.writeFileSync(scriptPath, FAKE_SIDECAR);
  fs.chmodSync(scriptPath, 0o755);
  process.env.FAKE_SIDECAR_MODE = mode;
  process.env.FAKE_SIDECAR_IDLE_MS = String(idleMs);
  return scriptPath;
}

afterEach(() => {
  process.env.FAKE_SIDECAR_MODE = "";
  process.env.FAKE_SIDECAR_IDLE_MS = "";
  // A test that rejects partway would otherwise leak the fake sidecar
  // process and hold vitest open; stop() runs on failure paths too.
  if (active !== null) {
    active.stop();
    active = null;
  }
  if (scratch !== null) {
    fs.rmSync(scratch, { recursive: true, force: true });
    scratch = null;
  }
});

describe("sidecar call idle timeout", () => {
  it("keeps a call alive past the idle window while progress events stream", async () => {
    const scriptPath = writeFakeSidecar("streaming", 500);
    const transport = new Sidecar(scriptPath, () => {}, { idleTimeoutMs: 500 });
    active = transport;

    await transport.start();
    const outcome = (await transport.call("slow")) as { done: boolean };

    expect(outcome).toEqual({ done: true });
  });

  it("survives several idle windows at the cadence a real bulk import guarantees", async () => {
    // A 10k-book folder import (tuxbooks-9zh) emits progress at least every
    // per-book budget (~31 s worst case) against a 60 s idle window. The
    // fake derives its cadence from the configured window, so the "half the
    // window" relationship survives any retune of these numbers.
    const scriptPath = writeFakeSidecar("sparse", 500);
    const transport = new Sidecar(scriptPath, () => {}, { idleTimeoutMs: 500 });
    active = transport;

    await transport.start();
    const outcome = (await transport.call("slow")) as { done: boolean };

    expect(outcome).toEqual({ done: true });
  });

  it("counts unrelated sidecar traffic as liveness for a pending call (documented tradeoff)", async () => {
    // Window 1000 ms, poke at 300 ms: a 3.3x margin, so a loaded CI stalling
    // the sleep cannot push the poke past the window and falsely reject a
    // healthy call. No gap between sidecar lines comes near the window
    // either (750 ms worst), while the hang itself outlives it.
    const scriptPath = writeFakeSidecar("interleaved", 1000);
    const transport = new Sidecar(scriptPath, () => {}, { idleTimeoutMs: 1000 });
    active = transport;

    await transport.start();
    const hang = transport.call("hang");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await transport.call("poke");

    await expect(hang).resolves.toEqual({ done: true });
  });

  it("rejects the call when the sidecar stays silent for the idle window", async () => {
    const scriptPath = writeFakeSidecar("silent", 400);
    const transport = new Sidecar(scriptPath, () => {}, { idleTimeoutMs: 400 });
    active = transport;

    await transport.start();
    await expect(transport.call("slow")).rejects.toThrow(RpcFailure);
    await expect(transport.call("slow")).rejects.toThrow(/timed out: slow/);
  });
});
