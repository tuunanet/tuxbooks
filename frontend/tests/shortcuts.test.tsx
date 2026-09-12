import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { comboFromEvent, useShortcut } from "@/lib/shortcuts";
import { ShortcutProvider } from "@/state/ShortcutProvider";

function fireKey(init: KeyboardEventInit, target: EventTarget = window): boolean {
  // Real keydowns bubble to the window-level listener; the synthetic event
  // must too (KeyboardEvent defaults to bubbles: false), or dispatching on
  // an element target can never exercise the provider's gating.
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

function Harness({
  combo,
  onFire,
  editableTarget,
  sliderTarget,
}: {
  combo: string | null;
  onFire: () => void;
  editableTarget?: boolean;
  sliderTarget?: boolean;
}) {
  useShortcut(combo, onFire);
  if (editableTarget) return <input aria-label="field" data-focused />;
  if (sliderTarget) return <div role="slider" aria-label="sizer" tabIndex={0} data-focused />;
  return <p>ready</p>;
}

describe("comboFromEvent", () => {
  it("normalizes letters, digits, and named keys", () => {
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: "k" }))).toBe("k");
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: "K" }))).toBe("k");
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: "Escape" }))).toBe("escape");
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: "Enter" }))).toBe("enter");
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: " " }))).toBe("space");
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: "ArrowLeft" }))).toBe("arrowleft");
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: "Home" }))).toBe("home");
  });

  it("maps ctrl and cmd to mod", () => {
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true }))).toBe("mod+k");
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))).toBe("mod+k");
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true }))).toBe("mod+b");
  });

  it("returns null for bare modifier presses", () => {
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: "Control" }))).toBeNull();
    expect(comboFromEvent(new KeyboardEvent("keydown", { key: "Meta" }))).toBeNull();
  });
});

describe("ShortcutProvider", () => {
  it("dispatches matching combos to registered handlers", () => {
    const onFire = vi.fn();
    render(
      <ShortcutProvider>
        <Harness combo="mod+k" onFire={onFire} />
      </ShortcutProvider>,
    );

    const prevented = fireKey({ key: "k", ctrlKey: true });
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(prevented).toBe(true);
  });

  it("does not fire for non-matching combos", () => {
    const onFire = vi.fn();
    render(
      <ShortcutProvider>
        <Harness combo="mod+k" onFire={onFire} />
      </ShortcutProvider>,
    );

    fireKey({ key: "k" });
    fireKey({ key: "j", ctrlKey: true });
    expect(onFire).not.toHaveBeenCalled();
  });

  it("ignores unmodified combos while typing in a form field", () => {
    const onFire = vi.fn();
    render(
      <ShortcutProvider>
        <Harness combo="space" onFire={onFire} editableTarget />
      </ShortcutProvider>,
    );

    const input = screen.getByLabelText("field");
    expect(fireKey({ key: " " }, input)).toBe(false);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("ignores navigation combos while a slider owns the keys", () => {
    const onFire = vi.fn();
    const { rerender } = render(
      <ShortcutProvider>
        <Harness combo="arrowright" onFire={onFire} sliderTarget />
      </ShortcutProvider>,
    );

    const slider = screen.getByLabelText("sizer");
    // The appearance sliders step their value with arrows/PageUp/PageDown;
    // a font-size change must never double as an engine page turn (#42).
    expect(fireKey({ key: "ArrowRight" }, slider)).toBe(false);
    expect(fireKey({ key: "PageDown" }, slider)).toBe(false);
    expect(onFire).not.toHaveBeenCalled();

    // Modifier combos still dispatch over a focused slider.
    const onModFire = vi.fn();
    rerender(
      <ShortcutProvider>
        <Harness combo="mod+k" onFire={onModFire} sliderTarget />
      </ShortcutProvider>,
    );
    expect(fireKey({ key: "k", ctrlKey: true }, slider)).toBe(true);
    expect(onModFire).toHaveBeenCalledTimes(1);
  });

  it("unregisters when the calling component unmounts", () => {
    const onFire = vi.fn();
    const { unmount } = render(
      <ShortcutProvider>
        <Harness combo="escape" onFire={onFire} />
      </ShortcutProvider>,
    );

    unmount();
    expect(fireKey({ key: "Escape" })).toBe(false);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("skips registration for a null combo", () => {
    const onFire = vi.fn();
    render(
      <ShortcutProvider>
        <Harness combo={null} onFire={onFire} />
      </ShortcutProvider>,
    );

    expect(fireKey({ key: "Escape" })).toBe(false);
    expect(onFire).not.toHaveBeenCalled();
  });

  it("registers a combo that becomes non-null", () => {
    const onFire = vi.fn();
    const { rerender } = render(
      <ShortcutProvider>
        <Harness combo={null} onFire={onFire} />
      </ShortcutProvider>,
    );
    expect(fireKey({ key: "End" })).toBe(false);

    rerender(
      <ShortcutProvider>
        <Harness combo="end" onFire={onFire} />
      </ShortcutProvider>,
    );
    expect(fireKey({ key: "End" })).toBe(true);
    expect(onFire).toHaveBeenCalledTimes(1);
  });
});
