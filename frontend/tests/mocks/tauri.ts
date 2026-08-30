import { vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

/**
 * Callers MUST hoist `vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))`
 * in their own test file before importing app code, so this helper can drive it.
 */
export const invokeMock = vi.mocked(invoke);

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
