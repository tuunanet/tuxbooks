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
 * Owns the single global keydown listener and dispatches matches to the most
 * recently registered handler for a combo. While the user is typing in a form
 * field, only modifier combos (e.g. Ctrl/Cmd+K) are dispatched.
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
      if (isEditableTarget(event.target) && !combo.startsWith("mod+")) return;
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
