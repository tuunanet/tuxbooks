import { spawn, ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * The Rust sidecar (docs/electron-migration.md): a JSON-RPC-over-stdio
 * service owned by the Electron main process. Spawned at startup,
 * health-checked with `ping`, restarted with backoff on unexpected exit,
 * and killed on app quit. It deliberately survives renderer reloads —
 * the renderer never talks to it directly.
 */

export class SidecarError extends Error {}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

/** JSON-RPC error carrying the sidecar's human-readable message. */
export class RpcFailure extends Error {}

const REQUEST_TIMEOUT_MS = 60_000;
const RESTART_BASE_MS = 500;
const RESTART_MAX_MS = 8_000;

export class Sidecar {
  private child: ChildProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  private events: (name: string, payload: unknown) => void;
  private stopped = false;
  private restartDelay = RESTART_BASE_MS;
  private startPromise: Promise<void> | null = null;

  constructor(
    private readonly binaryPath: string,
    events: (name: string, payload: unknown) => void,
  ) {
    this.events = events;
  }

  /** Spawn and health-check the service; safe to call repeatedly. */
  start(): Promise<void> {
    this.startPromise ??= this.startOnce().then(
      () => {},
      (error) => {
        // Allow a later retry after a failed start.
        this.startPromise = null;
        throw error;
      },
    );
    return this.startPromise;
  }

  /** All env the sidecar inherits must keep TEST_* overrides working. */
  private async startOnce(): Promise<void> {
    if (!fs.existsSync(this.binaryPath)) {
      throw new SidecarError(`sidecar binary not found at ${this.binaryPath}`);
    }
    this.stopped = false;
    // Under E2E diagnostics the sidecar's stderr goes to a per-instance file
    // (clearer than interleaving it with the app's own output).
    const debugLogPath =
      process.env.TUXBOOKS_DEBUG_IPC === "1" && process.env.E2E_RUN_ID
        ? `/tmp/tuxbooks-sidecar-${process.pid}-${process.env.E2E_RUN_ID}.log`
        : null;
    const stderr = debugLogPath ? fs.openSync(debugLogPath, "a") : "inherit";
    this.child = spawn(this.binaryPath, [], {
      stdio: ["pipe", "pipe", stderr],
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stdout!.on("data", (chunk: string) => this.onData(chunk));
    this.child.on("exit", (code, signal) => this.onExit(code, signal));

    await this.call("ping");
    this.restartDelay = RESTART_BASE_MS;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) return;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let message: {
      id?: number;
      result?: unknown;
      error?: { code: number; message: string };
      method?: string;
      params?: { name?: string; payload?: unknown };
    };
    try {
      message = JSON.parse(line);
    } catch {
      console.error("[sidecar] undecodable line:", line.slice(0, 200));
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new RpcFailure(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method === "event" && typeof message.params?.name === "string") {
      if (process.env.TUXBOOKS_DEBUG_IPC === "1") {
        console.log(`[sidecar] event: ${message.params.name}`);
      }
      this.events(message.params.name, message.params.payload ?? null);
    }
  }

  private onExit(code: number | null, signal: string | null): void {
    this.child = null;
    const error = new SidecarError(`sidecar exited unexpectedly (code=${code} signal=${signal})`);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();

    // Renderer reloads and window closes do not stop the sidecar; only an
    // explicit stop() suppresses the restart ladder (app quit).
    if (!this.stopped) {
      const delay = this.restartDelay;
      this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_MS);
      setTimeout(() => {
        this.startOnce().catch((err) => {
          console.error("[sidecar] restart failed:", err);
        });
      }, delay);
    }
  }

  /** One JSON-RPC call. Params must already be camelCase wire-shaped. */
  call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new SidecarError("sidecar is not running"));
    const id = this.nextId++;
    const request = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcFailure(`sidecar call timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin!.write(request + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new SidecarError(`failed to write request: ${err.message}`));
        }
      });
    });
  }

  /** Terminate the service for good (app quit). Idempotent. */
  stop(): void {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    if (!child) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new SidecarError("sidecar stopped"));
    }
    this.pending.clear();
    child.kill();
    // Escalate if a graceful kill is ignored (Rust service has no handlers,
    // but belt-and-braces for wedged states).
    setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 2_000).unref();
  }
}

/**
 * Resolve the sidecar binary. Dev runs use the cargo target dir; packaged
 * builds get an extraResources binary (phase 5 wiring).
 */
export function locateSidecar(resourcesPath: string): string {
  const override = process.env.TUXBOOKS_SIDECAR;
  if (override) return override;
  const devCandidates = [
    path.join(__dirname, "../../src-tauri/target/debug/tuxbooks"),
    path.join(__dirname, "../../target/debug/tuxbooks"),
  ];
  for (const candidate of devCandidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(resourcesPath, "sidecar/tuxbooks");
}
