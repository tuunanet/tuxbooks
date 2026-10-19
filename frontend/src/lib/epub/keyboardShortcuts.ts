/**
 * Reader shortcuts must work while keyboard focus sits inside the EPUB
 * content frame. The app's shortcut provider listens on the host window, and
 * keydown inside a frame never reaches it, so the engine routes the reader's
 * combos through the toolkit's keyboard-peripheral bridge: the injectable
 * intercepts those combos inside the frame (preventDefault included) and
 * reports them to the host, which re-dispatches a window keydown so the
 * normal registry runs unchanged.
 *
 * The combo list derives from READER_SHORTCUTS (the single source of truth
 * for what the reader binds), restricted to the surfaces the EPUB reader
 * can host.
 */

import type { IKeyboardPeripheralsConfig, KeyboardPeripheralEventData } from "@readium/navigator";
import type { KeyCombo } from "@readium/navigator-html-injectables";
import { READER_SHORTCUTS } from "@/lib/readerShortcuts";

export const EPUB_SHORTCUT_PERIPHERAL_TYPE = "tuxbooks_shortcut";

/** Named keys the reader binds; single characters derive from their code. */
const NAMED_KEY_CODES: Record<string, number> = {
  space: 32,
  pageup: 33,
  pagedown: 34,
  end: 35,
  home: 36,
  arrowleft: 37,
  arrowup: 38,
  arrowright: 39,
  arrowdown: 40,
  enter: 13,
  escape: 27,
};

function keyCodeFor(key: string): number | null {
  if (key in NAMED_KEY_CODES) return NAMED_KEY_CODES[key]!;
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return null;
}

interface ParsedCombo {
  key: string;
  mod: boolean;
  shift: boolean;
  alt: boolean;
}

/** Parse an engine combo ("mod+shift+h", "arrowright") into its parts. */
export function parseShortcutCombo(combo: string): ParsedCombo | null {
  const parts = combo.split("+");
  const key = parts.pop();
  if (!key) return null;
  return {
    key,
    mod: parts.includes("mod"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
  };
}

/**
 * The bridge config for the EPUB navigator. Only the global and reader
 * groups can fire on the reading surface; PDF-only combos stay out of the
 * frame interceptor.
 */
export function buildKeyboardPeripherals(): IKeyboardPeripheralsConfig {
  const keyCombos: KeyCombo[] = [];
  const seen = new Set<string>();
  for (const shortcut of READER_SHORTCUTS) {
    if (shortcut.group !== "global" && shortcut.group !== "reader") continue;
    for (const combo of shortcut.combos) {
      const parsed = parseShortcutCombo(combo);
      if (parsed === null) continue;
      const keyCode = keyCodeFor(parsed.key);
      if (keyCode === null) continue;
      // "mod" is Ctrl on Linux/Windows and Meta on macOS, and the matcher
      // treats an unspecified modifier as "must be absent", so each variant
      // is explicit.
      const bases = parsed.mod
        ? [
            { ctrl: true, meta: false },
            { ctrl: false, meta: true },
          ]
        : [{ ctrl: false, meta: false }];
      for (const base of bases) {
        const combo: KeyCombo = {
          keyCode,
          ctrl: base.ctrl,
          meta: base.meta,
          shift: parsed.shift,
          alt: parsed.alt,
        };
        const id = JSON.stringify(combo);
        if (seen.has(id)) continue;
        seen.add(id);
        keyCombos.push(combo);
      }
    }
  }
  return [{ type: EPUB_SHORTCUT_PERIPHERAL_TYPE, keyCombos }];
}

/**
 * Re-dispatch a forwarded frame key as a host keydown. The provider owns the
 * combo matching, so this only reconstructs the event; the per-evidence
 * guard mirrors its policy of letting non-modifier combos through only when
 * no form control holds focus inside the book.
 */
export function dispatchForwardedShortcut(data: KeyboardPeripheralEventData): void {
  const modified = data.ctrlKey || data.metaKey || data.altKey;
  if (!modified && data.interactiveElement !== undefined) return;
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: data.key,
      code: data.code,
      ctrlKey: data.ctrlKey,
      altKey: data.altKey,
      shiftKey: data.shiftKey,
      metaKey: data.metaKey,
      bubbles: true,
      cancelable: true,
    }),
  );
}
