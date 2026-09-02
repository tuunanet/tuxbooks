import { beforeAll, afterEach } from "vitest";
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

afterEach(() => {
  cleanup();
});
