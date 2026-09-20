import { useEffect, type RefObject } from "react";

import { wheelDeltaPx } from "./pdf/pdfLayout";

/**
 * Quiet gap that ends a wheel gesture. Events arriving within this window of
 * each other are one gesture; after it the next event picks its own axis.
 */
export const AXIS_LOCK_QUIET_MS = 300;

type Axis = "x" | "y";

/** Nearest scrollable ancestor of `from`, below (not including) `boundary`. */
function nestedScroller(from: EventTarget | null, boundary: HTMLElement): HTMLElement | null {
  let element = from instanceof Element ? from : null;
  while (element && element !== boundary) {
    if (element instanceof HTMLElement && isScrollable(element)) return element;
    element = element.parentElement;
  }
  return null;
}

function isScrollable(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  const vertical = style.overflowY === "auto" || style.overflowY === "scroll";
  const horizontal = style.overflowX === "auto" || style.overflowX === "scroll";
  return (
    (vertical && element.scrollHeight > element.clientHeight) ||
    (horizontal && element.scrollWidth > element.clientWidth)
  );
}

function wheelScale(event: WheelEvent, container: HTMLElement): number {
  return wheelDeltaPx(1, event.deltaMode, container.clientHeight);
}

/**
 * Locks a wheel gesture to the axis it began on. A free-spinning wheel keeps
 * emitting events after Shift is released, so the browser otherwise flips a
 * horizontal scroll into a vertical one mid-spin. While a gesture is active
 * (events within AXIS_LOCK_QUIET_MS of each other) events that would switch
 * axis are redirected onto the locked axis; events already matching it are
 * left to the browser, so native smooth scrolling is unaffected. Ctrl+wheel is
 * ignored (reader zoom owns it), as are events aimed at a nested scroller
 * (thumbnail and search lists).
 */
export function useAxisLockedWheel(containerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let axis: Axis | null = null;
    let timer: number | null = null;
    const endGesture = () => {
      axis = null;
      timer = null;
    };

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return; // Ctrl+wheel zooms the reader.
      if (nestedScroller(event.target, container)) return; // Nested list scrolls itself.

      const intended: Axis =
        event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) ? "x" : "y";
      if (!axis) axis = intended;
      if (timer !== null) clearTimeout(timer);
      timer = window.setTimeout(endGesture, AXIS_LOCK_QUIET_MS);

      if (intended === axis) return; // Browser scrolls the locked axis natively.

      // Shift state changed mid-gesture (typically released): keep scrolling
      // the axis the gesture started on instead of jumping to the other one.
      const scale = wheelScale(event, container);
      event.preventDefault();
      if (axis === "x") container.scrollLeft += (event.deltaX || event.deltaY) * scale;
      else container.scrollTop += event.deltaY * scale;
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
      if (timer !== null) clearTimeout(timer);
    };
  }, [containerRef]);
}
