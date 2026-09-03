import { vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Callers MUST hoist these mocks in their own test file before importing
 * app code, so this helper can drive them:
 *
 *   vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
 *   vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
 */
export const invokeMock = vi.mocked(invoke);
export const listenMock = vi.mocked(listen);

/** Route mocked `invoke` calls by command name. Passing an `Error` makes it reject. */
export function mockInvoke(responses: Record<string, unknown | Promise<unknown>>): void {
  invokeMock.mockImplementation((command: string) => {
    const response = responses[command];
    if (response === undefined) {
      return Promise.reject(new Error(`unexpected invoke(${command}) in test`));
    }
    if (response instanceof Error) {
      return Promise.reject(response);
    }
    return Promise.resolve(response);
  });
}

/**
 * Simulate a backend event (e.g. `import-progress`) reaching the app: calls
 * every handler registered through the mocked `listen` for `event`.
 */
export function emitTauriEvent(event: string, payload: unknown): void {
  for (const call of listenMock.mock.calls) {
    if (call[0] === event) {
      const handler = call[1] as (e: { payload: unknown }) => void;
      handler({ payload });
    }
  }
}
