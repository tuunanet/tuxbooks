import { beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { cleanup, configure } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  installMockIntersectionObserver,
  resetIntersectionObservers,
} from "./mocks/intersectionObserver";
import { installMockResizeObserver, resetResizeObservers } from "./mocks/resizeObserver";

// Coverage-instrumented runs are slower on the main thread; the 1s default
// otherwise makes waitFor-based tests flaky exactly when the gate matters.
configure({ asyncUtilTimeout: 2000 });

// @tanstack/react-virtual arms a real `setTimeout` scroll-end debounce
// (`isScrollingResetDelay`, 150ms) whose timer id is trapped in the
// `debounce` closure, so unmounting cannot cancel it. When the last test in
// a file scrolls a virtualized list, that timer can fire after Vitest tears
// jsdom down, and React then throws "window is not defined" (the coverage
// job hit exactly this). Drain it in afterAll while the environment is still
// alive; files that never scrolled skip the wait.
const VIRTUALIZER_SCROLL_DRAIN_MS = 250;
let virtualizerScrolled = false;
const markVirtualizerScrolled = () => {
  virtualizerScrolled = true;
};

beforeAll(() => {
  // Node-environment tests (e.g. the PDFium WASM integration) have no DOM.
  if (typeof window === "undefined") return;
  virtualizerScrolled = false;
  // Capture phase: scroll events do not bubble, but they still travel down
  // the tree, so this sees every virtualized list's scroll.
  document.addEventListener("scroll", markVirtualizerScrolled, true);

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

  // Radix ScrollArea and Slider observe size changes; the virtualized
  // library grid needs tests to fire real entries (tests/mocks/resizeObserver).
  if (!globalThis.ResizeObserver || globalThis.ResizeObserver.name !== "MockResizeObserver") {
    installMockResizeObserver();
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
      clearRect() {},
    }) as unknown as CanvasRenderingContext2D) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  if (typeof window === "undefined") return;
  cleanup();
  resetIntersectionObservers();
  resetResizeObservers();
});

// Reader appearance and app theme persist through localStorage; clear between
// tests so one test's preference can never leak into the next.
beforeEach(() => {
  if (typeof window === "undefined") return;
  window.localStorage.clear();
});

afterEach(() => {
  if (typeof window === "undefined") return;
  cleanup();
});

afterAll(async () => {
  if (typeof window === "undefined") return;
  document.removeEventListener("scroll", markVirtualizerScrolled, true);
  if (virtualizerScrolled) {
    await new Promise((resolve) => setTimeout(resolve, VIRTUALIZER_SCROLL_DRAIN_MS));
  }
});
