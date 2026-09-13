import { beforeAll, beforeEach, afterEach } from "vitest";
import { cleanup, configure } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  installMockIntersectionObserver,
  resetIntersectionObservers,
} from "./mocks/intersectionObserver";

// Coverage-instrumented runs are slower on the main thread; the 1s default
// otherwise makes waitFor-based tests flaky exactly when the gate matters.
configure({ asyncUtilTimeout: 2000 });

beforeAll(() => {
  // jsdom lacks the pointer-capture plumbing Radix primitives rely on.
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});

  // vitest's jsdom global exposes a localStorage accessor that resolves to
  // undefined (jsdom's real storage is not wired through the global proxy);
  // the app theme persists through localStorage, so provide a working one.
  if (!window.localStorage) {
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return store.size;
        },
        key: (index: number) => [...store.keys()][index] ?? null,
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
          store.set(key, String(value));
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
        clear: () => {
          store.clear();
        },
      } satisfies Storage,
    });
  }

  // The (temporary, pre-migration) foliate-js paginator queries the color
  // scheme at construction time; jsdom has no matchMedia.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  // Radix ScrollArea and Slider observe size changes.
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }

  // The PDF virtualization observes page slots; tests fire synthetic
  // entries through tests/mocks/intersectionObserver.ts.
  if (!globalThis.IntersectionObserver) {
    installMockIntersectionObserver();
  }

  // jsdom defines getContext but always returns null (no canvas package);
  // the PDF reader needs a context object for its render/blit calls in
  // unit tests (PDF.js itself is mocked).
  HTMLCanvasElement.prototype.getContext = (() =>
    ({
      drawImage() {},
    }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  cleanup();
  resetIntersectionObservers();
});

// Reader appearance and app theme persist through localStorage; clear between
// tests so one test's preference can never leak into the next.
beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});
