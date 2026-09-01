import { vi } from "vitest";

/**
 * Geometry stubs for scroll-tracking tests. jsdom performs no layout, so
 * the scroll math reads zeros; these stubs give the scroll container a
 * fixed viewport and make the document element's viewport position move
 * with scrollTop exactly as it does in a live browser (rect.top decreases
 * as the container scrolls down), which is what keeps the anchor math
 * scroll-invariant.
 */
export function makeDomRect(top: number): DOMRect {
  return {
    top,
    height: 720,
    width: 1000,
    bottom: top + 720,
    left: 0,
    right: 1000,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

export function stubScrollGeometry(container: HTMLElement, documentEl: HTMLElement): void {
  Object.defineProperty(container, "clientHeight", { value: 720, configurable: true });
  vi.spyOn(container, "getBoundingClientRect").mockReturnValue(makeDomRect(0));
  vi.spyOn(documentEl, "getBoundingClientRect").mockImplementation(() =>
    makeDomRect(-container.scrollTop),
  );
}

/** Move a scroll container and emit the scroll event the browser would. */
export function scrollTo(container: HTMLElement, scrollTop: number): void {
  container.scrollTop = scrollTop;
  container.dispatchEvent(new Event("scroll"));
}
