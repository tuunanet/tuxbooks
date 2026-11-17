import { beforeAll, beforeEach, afterEach, afterAll } from "vite-plus/test";
import { cleanup, configure } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  installMockIntersectionObserver,
  resetIntersectionObservers,
} from "./mocks/intersectionObserver";
import { installMockResizeObserver, resetResizeObservers } from "./mocks/resizeObserver";

// Coverage-instrumented runs are slower on the main thread; the 1s default would
// make waitFor-based tests flaky exactly when the gate matters.
configure({ asyncUtilTimeout: 2000 });

// @tanstack/react-virtual arms a real `setTimeout` debounce whose timer id is
// trapped in its closure, so unmounting cannot cancel it; a timer firing after
// jsdom teardown throws "window is not defined". Drain it in afterAll.
const VIRTUALIZER_SCROLL_DRAIN_MS = 250;
let virtualizerScrolled = false;
const markVirtualizerScrolled = () => {
  virtualizerScrolled = true;
};

beforeAll(() => {
  if (typeof window === "undefined") return;
  virtualizerScrolled = false;
  // Capture phase: scroll events do not bubble but do travel down the tree.
  document.addEventListener("scroll", markVirtualizerScrolled, true);

  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? (() => {});

  // vitest's jsdom global localStorage resolves to undefined (real storage is
  // not wired through the proxy), and the app theme persists through it.
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

  if (!globalThis.ResizeObserver || globalThis.ResizeObserver.name !== "MockResizeObserver") {
    installMockResizeObserver();
  }

  if (!globalThis.IntersectionObserver) {
    installMockIntersectionObserver();
  }

  // jsdom's getContext always returns null, but the PDF reader needs a context.
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
