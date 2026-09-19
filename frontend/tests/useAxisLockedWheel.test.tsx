import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useAxisLockedWheel, AXIS_LOCK_QUIET_MS } from "@/components/reader/useAxisLockedWheel";

function makeContainer(): HTMLDivElement {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientWidth", { value: 500, configurable: true });
  Object.defineProperty(container, "clientHeight", { value: 500, configurable: true });
  Object.defineProperty(container, "scrollWidth", { value: 1500, configurable: true });
  Object.defineProperty(container, "scrollHeight", { value: 1500, configurable: true });
  document.body.appendChild(container);
  return container;
}

function wheel(target: HTMLElement, init: WheelEventInit & { shiftKey?: boolean }): WheelEvent {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("useAxisLockedWheel", () => {
  it("redirects a released-Shift continuation onto the horizontal axis", () => {
    const container = makeContainer();
    const ref = { current: container };
    renderHook(() => useAxisLockedWheel(ref));

    // Shift+wheel starts a horizontal gesture; the browser owns it natively.
    const first = wheel(container, { deltaY: 120, shiftKey: true });
    expect(first.defaultPrevented).toBe(false);
    expect(container.scrollLeft).toBe(0);

    // Shift released while the free-spinning wheel keeps going: the event
    // would scroll vertically, so it is redirected to horizontal instead.
    const released = wheel(container, { deltaY: 120 });
    expect(released.defaultPrevented).toBe(true);
    expect(container.scrollLeft).toBe(120);
    expect(container.scrollTop).toBe(0);
  });

  it("starts a fresh axis once the wheel has gone quiet", () => {
    vi.useFakeTimers();
    const container = makeContainer();
    const ref = { current: container };
    renderHook(() => useAxisLockedWheel(ref));

    wheel(container, { deltaY: 120, shiftKey: true });
    vi.advanceTimersByTime(AXIS_LOCK_QUIET_MS + 1);

    // A new gesture with no Shift is vertical and allowed through natively.
    const vertical = wheel(container, { deltaY: 120 });
    expect(vertical.defaultPrevented).toBe(false);
    expect(container.scrollLeft).toBe(0);
  });

  it("keeps a shift press mid-vertical-gesture scrolling vertically", () => {
    const container = makeContainer();
    const ref = { current: container };
    renderHook(() => useAxisLockedWheel(ref));

    wheel(container, { deltaY: 120 });
    const shifted = wheel(container, { deltaY: 120, shiftKey: true });
    expect(shifted.defaultPrevented).toBe(true);
    expect(container.scrollTop).toBe(120);
    expect(container.scrollLeft).toBe(0);
  });

  it("leaves Ctrl+wheel to the reader zoom", () => {
    const container = makeContainer();
    const ref = { current: container };
    renderHook(() => useAxisLockedWheel(ref));

    const zoom = wheel(container, { deltaY: 120, ctrlKey: true });
    expect(zoom.defaultPrevented).toBe(false);
    expect(container.scrollTop).toBe(0);
    expect(container.scrollLeft).toBe(0);
  });

  it("does not hijack a wheel over a nested scroller", () => {
    const container = makeContainer();
    const ref = { current: container };
    renderHook(() => useAxisLockedWheel(ref));

    const nested = document.createElement("div");
    nested.style.overflowY = "auto";
    Object.defineProperty(nested, "clientHeight", { value: 100, configurable: true });
    Object.defineProperty(nested, "scrollHeight", { value: 400, configurable: true });
    container.appendChild(nested);

    const event = wheel(nested, { deltaY: 120 });
    expect(event.defaultPrevented).toBe(false);
    expect(container.scrollTop).toBe(0);
  });
});
