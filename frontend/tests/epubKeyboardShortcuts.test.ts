import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildKeyboardPeripherals,
  dispatchForwardedShortcut,
  parseShortcutCombo,
} from "@/lib/epub/keyboardShortcuts";
import type { KeyboardPeripheralEventData } from "@readium/navigator";

describe("epub keyboard shortcuts bridge", () => {
  it("parses engine combos into key parts", () => {
    expect(parseShortcutCombo("mod+shift+h")).toEqual({
      key: "h",
      mod: true,
      shift: true,
      alt: false,
    });
    expect(parseShortcutCombo("arrowright")).toEqual({
      key: "arrowright",
      mod: false,
      shift: false,
      alt: false,
    });
  });

  it("forwards the reader combos with Ctrl and Meta variants", () => {
    const [peripheral] = buildKeyboardPeripherals();
    expect(peripheral?.type).toBe("tuxbooks_shortcut");
    const combos = peripheral!.keyCombos;

    // mod+shift+h (highlights panel): H is keyCode 72.
    const ctrlShiftH = combos.find(
      (combo) => combo.keyCode === 72 && combo.ctrl === true && combo.shift === true,
    );
    const metaShiftH = combos.find(
      (combo) => combo.keyCode === 72 && combo.meta === true && combo.shift === true,
    );
    expect(ctrlShiftH).toBeDefined();
    expect(metaShiftH).toBeDefined();

    // Bare navigation keys carry no modifiers (the matcher requires absence).
    const space = combos.find((combo) => combo.keyCode === 32);
    expect(space).toMatchObject({ ctrl: false, meta: false, shift: false, alt: false });
    expect(combos.some((combo) => combo.keyCode === 39)).toBe(true); // arrowright

    // Typing keys must reach a focused field; only modifier shortcuts pass
    // through the navigator's capture-phase host listener.
    expect(space?.suppressOnInteractiveElement).toBe(true);
    expect(ctrlShiftH?.suppressOnInteractiveElement).toBe(false);
    expect(metaShiftH?.suppressOnInteractiveElement).toBe(false);

    // PDF-only combos stay out of the frame.
    expect(combos.some((combo) => combo.keyCode === 61)).toBe(false); // mod+=
  });

  it("re-dispatches a forwarded key as a host keydown", () => {
    const listener = vi.fn();
    window.addEventListener("keydown", listener);
    try {
      dispatchForwardedShortcut({
        type: "tuxbooks_shortcut",
        timestamp: 0,
        key: "h",
        code: "KeyH",
        keyCode: 72,
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
        metaKey: false,
        targetFrameSrc: "",
      } as KeyboardPeripheralEventData);

      expect(listener).toHaveBeenCalledTimes(1);
      const event = listener.mock.calls[0]![0] as KeyboardEvent;
      expect(event.key).toBe("h");
      expect(event.ctrlKey).toBe(true);
      expect(event.shiftKey).toBe(true);
    } finally {
      window.removeEventListener("keydown", listener);
    }
  });

  it("suppresses bare keys while a control has focus in the book", () => {
    const listener = vi.fn();
    window.addEventListener("keydown", listener);
    try {
      dispatchForwardedShortcut({
        type: "tuxbooks_shortcut",
        timestamp: 0,
        key: "arrowright",
        code: "ArrowRight",
        keyCode: 39,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        metaKey: false,
        targetFrameSrc: "",
        interactiveElement: document.createElement("input"),
      } as KeyboardPeripheralEventData);
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", listener);
    }
  });
});
