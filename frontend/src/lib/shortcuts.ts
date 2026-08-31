import { createContext, useContext, useEffect, useRef } from "react";

/**
 * Centralized keyboard shortcut mechanism (task §19). Components register
 * combos via `useShortcut`; nothing hardcodes keys inside leaf components.
 * A combo is a normalized string, e.g. "mod+k", "escape", "enter", "space",
 * "arrowleft", "home". "mod" matches Ctrl on Linux/Windows and Cmd elsewhere.
 */
export type ShortcutHandler = (event: KeyboardEvent) => void;

export interface ShortcutRegistry {
  /** Registers a handler; returns an unregister function. */
  register(combo: string, handler: ShortcutHandler): () => void;
}

export const ShortcutContext = createContext<ShortcutRegistry | null>(null);

/**
 * Register `combo` for as long as the calling component is mounted. Handlers
 * registered later win over earlier ones for the same combo (last-registered
 * overlay gets Escape first) and are removed again on unmount, so a
 * component's registration lifetime is its effective scope.
 */
export function useShortcut(combo: string, handler: ShortcutHandler): void {
  const registry = useContext(ShortcutContext);
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    if (!registry) {
      throw new Error("useShortcut must be used within ShortcutProvider");
    }
    return registry.register(combo, (event) => handlerRef.current(event));
  }, [registry, combo]);
}

const BARE_MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

/** Normalize a keyboard event into a combo string, or null for bare modifiers. */
export function comboFromEvent(event: KeyboardEvent): string | null {
  if (BARE_MODIFIER_KEYS.has(event.key)) return null;
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key === " " ? "space" : event.key.toLowerCase();
  return mod ? `mod+${key}` : key;
}
