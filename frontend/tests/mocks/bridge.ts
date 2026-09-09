import { vi, type Mock } from "vitest";

/**
 * Fake of the `window.tuxbooks` preload bridge (electron/preload). App code
 * reaches the outside world only through `@/lib/bridge`, which reads this
 * object — so tests install the fake and drive it, never the real Electron
 * APIs. Importing this module installs the fake (vitest isolates module
 * state per test file); route calls with `mockInvoke` and fire events with
 * `emitBridgeEvent`.
 */

type EventListener = (payload: unknown) => void;

const listeners = new Map<string, Set<EventListener>>();

export const invokeMock = vi.fn();

export const pickDirectoryMock: Mock<() => Promise<string | null>> = vi.fn(async () => null);
export const pickBookFileMock: Mock<() => Promise<string | null>> = vi.fn(async () => null);
export const pickBookFilesMock: Mock<() => Promise<string[]>> = vi.fn(async () => []);
export const pickCoverImageMock: Mock<() => Promise<string | null>> = vi.fn(async () => null);
export const revealInFileManagerMock: Mock<(target: string) => Promise<void>> = vi.fn(
  async () => {},
);
export const fetchBookBytesMock: Mock<(bookId: number, format: string) => Promise<ArrayBuffer>> =
  vi.fn(async () => new ArrayBuffer(16));
export const pathForFileMock: Mock<(file: File) => string> = vi.fn(
  (file: File) => `/dropped/${file.name}`,
);

/** Re-install the fake (clears event listeners; invoke routing is per-test). */
export function installTuxbooksMock(): void {
  listeners.clear();
  window.tuxbooks = {
    invoke: (method, params) =>
      params === undefined ? invokeMock(method) : invokeMock(method, params),
    onEvent: (name, callback) => {
      let set = listeners.get(name);
      if (!set) {
        set = new Set();
        listeners.set(name, set);
      }
      set.add(callback);
      return () => {
        set?.delete(callback);
      };
    },
    pickDirectory: () => pickDirectoryMock(),
    pickBookFile: () => pickBookFileMock(),
    pickBookFiles: () => pickBookFilesMock(),
    pickCoverImage: () => pickCoverImageMock(),
    revealInFileManager: (target: string) => revealInFileManagerMock(target),
    fetchBookBytes: (bookId: number, format: string) => fetchBookBytesMock(bookId, format),
    pathForFile: (file: File) => pathForFileMock(file),
  };
}

installTuxbooksMock();

/** Route mocked `invoke` calls by method name. Passing an `Error` makes it reject. */
export function mockInvoke(responses: Record<string, unknown | Promise<unknown>>): void {
  invokeMock.mockImplementation((method: string) => {
    const response = responses[method];
    if (response === undefined) {
      return Promise.reject(new Error(`unexpected invoke(${method}) in test`));
    }
    if (response instanceof Error) {
      return Promise.reject(response);
    }
    return Promise.resolve(response);
  });
}

/** Simulate a backend event (e.g. `import-progress`) reaching the app. */
export function emitBridgeEvent(name: string, payload: unknown): void {
  for (const callback of listeners.get(name) ?? []) {
    callback(payload);
  }
}

/**
 * Covers are addressed through the scoped `tuxbooks://cover/<encoded path>`
 * protocol; tests assert on this exact URL shape.
 */
export function coverUrlFor(path: string): string {
  return `tuxbooks://cover/${encodeURIComponent(path)}`;
}
