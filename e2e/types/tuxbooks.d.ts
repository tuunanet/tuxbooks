/**
 * Minimal ambient typing for the renderer's preload bridge, as visible to
 * the E2E specs (`window.tuxbooks.invoke` — annotations/progress suites use
 * it for database-level setup). The full contract lives in
 * frontend/src/lib/bridge.ts; only what the specs call is declared here.
 */
declare global {
  interface Window {
    tuxbooks?: {
      invoke: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
    };
  }
}

export {};
