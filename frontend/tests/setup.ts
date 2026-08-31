import { beforeAll, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  installMockIntersectionObserver,
  resetIntersectionObservers,
} from "./mocks/intersectionObserver";

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
  // the PDF reader only needs a context object to hand to the (mocked)
  // PDF.js render call in unit tests.
  HTMLCanvasElement.prototype.getContext =
    (() => ({})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  cleanup();
  resetIntersectionObservers();
});

afterEach(() => {
  cleanup();
});
