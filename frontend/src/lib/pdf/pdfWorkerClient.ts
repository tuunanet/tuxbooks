import { PdfRenderCancelledError } from "./pdfEngineTypes";

/**
 * Request/response plumbing shared by the PDF engine workers. One client owns
 * one worker and one document; the engine adapter terminates the client when
 * the document closes, which frees the whole WASM heap. Requests are
 * `{ id, method, params }`; responses are `{ id, ok, result | error }`.
 */

export interface WorkerResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Out-of-band worker diagnostic (no request id). The worker reports every
 * operation's start, finish, and WASM heap size; the engine logs the stream
 * at debug level, and the main process captures the renderer console, so the
 * last line survives a renderer crash.
 */
export interface WorkerDiag {
  kind: "pdf-worker-diag";
  phase: "begin" | "end" | "error" | "unhandled";
  method: string;
  requestId: number;
  page?: number;
  ms?: number;
  heapBytes: number;
  message?: string;
}

/**
 * A worker request that never returns would otherwise look like a UI freeze
 * with no trace; the watchdog reports it while it is still in flight (the
 * engine, not the worker, owns the timer, so it still fires if the worker is
 * blocked in a synchronous XHR or a WASM loop).
 */
const WORKER_STALL_WARN_MS = 10_000;
const WORKER_STALL_POLL_MS = 5_000;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  method: string;
  startedAt: number;
  warned: boolean;
}

export class WorkerClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private failureListeners = new Set<() => void>();
  private idleResolvers = new Set<() => void>();
  private failed = false;
  private terminated = false;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private lastDiag = "";

  constructor(
    workerUrl: string,
    private readonly engineLabel = "PDF",
  ) {
    this.worker = new Worker(workerUrl, { type: "module" });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse | WorkerDiag>) => {
      const data = event.data;
      if ("kind" in data) {
        this.recordDiag(data);
        return;
      }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      if (data.ok) pending.resolve(data.result);
      else pending.reject(new Error(data.error ?? `${this.engineLabel} worker failure`));
      this.notifyIdle();
    };
    this.worker.onerror = (event) => {
      // A dead worker is a diagnostic failure, not cancellation: every
      // pending request rejects, and listeners (the document owner) hear
      // about it exactly once so recovery can start.
      const pending = [...this.pending.values()];
      this.pending.clear();
      this.stopStallWatch();
      this.failed = true;
      this.notifyIdle();
      const failure = new Error(event.message || `${this.engineLabel} worker failed to load`);
      console.error(
        `[pdf-engine] worker gone: ${failure.message}` +
          (this.lastDiag ? `; last operation ${this.lastDiag}` : ""),
      );
      for (const request of pending) {
        request.reject(failure);
      }
      const listeners = [...this.failureListeners];
      this.failureListeners.clear();
      for (const listener of listeners) {
        listener();
      }
    };
    this.stallTimer = setInterval(() => this.reportStalls(), WORKER_STALL_POLL_MS);
  }

  /** Log one worker breadcrumb and remember it for the death/crash report. */
  private recordDiag(diag: WorkerDiag): void {
    const segments = [
      diag.method,
      diag.page !== undefined ? `page=${diag.page}` : null,
      diag.phase,
      diag.ms !== undefined ? `${Math.round(diag.ms)}ms` : null,
      `heap=${(diag.heapBytes / 1048576).toFixed(1)}MB`,
      diag.message ?? null,
    ].filter((segment): segment is string => segment !== null);
    this.lastDiag = segments.join(" ");
    console.debug(`[pdf-worker] ${this.lastDiag}`);
  }

  /** Warn once per request that has been in flight past the stall budget. */
  private reportStalls(): void {
    const now = performance.now();
    for (const [id, pending] of this.pending) {
      if (pending.warned || now - pending.startedAt < WORKER_STALL_WARN_MS) continue;
      pending.warned = true;
      console.warn(
        `[pdf-engine] worker request stalled: ${pending.method} #${id}` +
          ` running ${Math.round(now - pending.startedAt)}ms` +
          (this.lastDiag ? `; last completed ${this.lastDiag}` : ""),
      );
    }
  }

  private stopStallWatch(): void {
    if (this.stallTimer !== null) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }

  /**
   * Resolves once no request is in flight. A recycling document lets the old
   * worker finish its queued renders before terminating it, so the swap is
   * invisible to callers; a terminated worker resolves immediately.
   */
  whenIdle(): Promise<void> {
    if (this.terminated || this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.add(resolve));
  }

  private notifyIdle(): void {
    if (this.pending.size > 0) return;
    for (const resolve of this.idleResolvers) resolve();
    this.idleResolvers.clear();
  }

  /** Registers a one-shot worker-death listener; returns the unsubscribe fn. */
  onFailed(listener: () => void): () => void {
    if (this.failed) {
      // Already gone: notify without registering.
      listener();
      return () => {};
    }
    this.failureListeners.add(listener);
    return () => this.failureListeners.delete(listener);
  }

  request(method: string, params: unknown, transfer: Transferable[] = []): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve,
        reject,
        method,
        startedAt: performance.now(),
        warned: false,
      });
      this.worker.postMessage({ id, method, params }, transfer);
    });
  }

  requestCancellable(
    method: string,
    params: unknown,
  ): { result: Promise<unknown>; cancel: () => void } {
    const id = this.nextId++;
    let cancelled = false;
    const result = new Promise((resolve, reject) => {
      this.pending.set(id, {
        method,
        startedAt: performance.now(),
        warned: false,
        resolve: (value) => {
          if (cancelled) {
            reject(new PdfRenderCancelledError());
            return;
          }
          resolve(value);
        },
        reject: (reason) => {
          reject(cancelled ? new PdfRenderCancelledError() : reason);
        },
      });
      this.worker.postMessage({ id, method, params });
    });
    return {
      result,
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.reject(new PdfRenderCancelledError());
          this.notifyIdle();
        }
      },
    };
  }

  terminate(): void {
    this.terminated = true;
    this.stopStallWatch();
    this.worker.terminate();
    this.notifyIdle();
  }
}
