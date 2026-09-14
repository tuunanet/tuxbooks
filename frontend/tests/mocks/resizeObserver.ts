import { vi } from "vitest";

/**
 * Controllable ResizeObserver fake (jsdom has none). The no-op stub in
 * setup.ts satisfies Radix, but layout-driven code — the virtualized
 * library grid — needs tests to fire real entries: render, then
 * `fireResize(width, height)` to run every live observer's callback.
 */
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  observed: Element[] = [];

  constructor(private callback: ResizeObserverCallback) {
    MockResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.observed.push(target);
  }

  unobserve(target: Element): void {
    this.observed = this.observed.filter((element) => element !== target);
  }

  disconnect(): void {
    this.observed = [];
  }

  fire(width: number, height: number): void {
    const entries = this.observed.map(
      (target) =>
        ({
          target,
          contentRect: {
            width,
            height,
            top: 0,
            left: 0,
            bottom: height,
            right: width,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          } as DOMRectReadOnly,
          borderBoxSize: [],
          contentBoxSize: [],
          devicePixelContentBoxSize: [],
        }) as unknown as ResizeObserverEntry,
    );
    this.callback(entries, this as unknown as ResizeObserver);
  }
}

export function installMockResizeObserver(): void {
  globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
}

export function resetResizeObservers(): void {
  MockResizeObserver.instances = [];
}

/** Fire one resize entry (width, height) at every live observer. */
export function fireResize(width: number, height: number): void {
  for (const observer of MockResizeObserver.instances) observer.fire(width, height);
}

/**
 * Fire a resize entry only at observers watching `target` — layout-driven
 * code (the virtualizer) must not receive entries meant for another
 * element: its row measurers would re-measure with the test's geometry and
 * collapse every row to that height.
 */
export function fireResizeOn(target: Element, width: number, height: number): void {
  for (const observer of MockResizeObserver.instances) {
    if (observer.observed.includes(target)) observer.fire(width, height);
  }
}

/** A spy-friendly element rect for scroll-viewport geometry. */
export function makeRect(width: number, height: number): DOMRect {
  return {
    top: 0,
    left: 0,
    bottom: height,
    right: width,
    x: 0,
    y: 0,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Spy every element rect to a fixed size (call before `render`). */
export function stubElementRect(width: number, height: number): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(makeRect(width, height));
}
