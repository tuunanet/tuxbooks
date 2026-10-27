import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { ShortcutContext, comboFromEvent, type ShortcutHandler } from "@/lib/shortcuts";

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

/**
 * True when the keydown originates from a focused slider thumb (the reader's
 * appearance sliders). The slider owns its navigation keys — arrows step its
 * value, PageUp/PageDown/Home/End move by larger steps — so a font-size
 * change must never double as an engine page turn (issue #42).
 */
function isSliderTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="slider"]') !== null;
}

/**
 * True when the keydown names a key the focused button activates
 * natively (Space on keyup, Enter on keydown): the button owns that
 * activation, so an unmodified shortcut firing on keydown as well would
 * double-fire with it — a focused book-mode turn zone plus Space turned
 * two spreads per press. Only the activation pair belongs to the button;
 * other combos (arrows, Home/End, modifiers) still dispatch as before.
 */
function ownsNativeActivation(target: EventTarget | null, combo: string): boolean {
  if (combo !== "space" && combo !== "enter") return false;
  return target instanceof Element && target.closest("button") !== null;
}

/**
 * Owns the single global keydown listener and dispatches matches to the most
 * recently registered handler for a combo. While the user is typing in a form
 * field or steering a slider, only modifier combos (e.g. Ctrl/Cmd+K) are
 * dispatched; a focused button additionally keeps its own activation keys
 * (Space/Enter) away from the registry.
 */
export function ShortcutProvider({ children }: { children: ReactNode }) {
  const stacks = useRef(new Map<string, ShortcutHandler[]>());

  const registry = useMemo(
    () => ({
      register(combo: string, handler: ShortcutHandler) {
        const stack = stacks.current.get(combo) ?? [];
        stack.push(handler);
        stacks.current.set(combo, stack);
        return () => {
          const current = stacks.current.get(combo);
          if (!current) return;
          const index = current.lastIndexOf(handler);
          if (index !== -1) current.splice(index, 1);
          if (current.length === 0) stacks.current.delete(combo);
        };
      },
    }),
    [],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const combo = comboFromEvent(event);
      if (!combo) return;
      if (
        (isEditableTarget(event.target) ||
          isSliderTarget(event.target) ||
          ownsNativeActivation(event.target, combo)) &&
        !combo.startsWith("mod+")
      ) {
        return;
      }
      const stack = stacks.current.get(combo);
      const top = stack ? stack[stack.length - 1] : undefined;
      if (top) {
        event.preventDefault();
        top(event);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return <ShortcutContext.Provider value={registry}>{children}</ShortcutContext.Provider>;
}
