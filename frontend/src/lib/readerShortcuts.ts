/**
 * Single source of truth for the user-facing keyboard shortcuts. The engine
 * (`lib/shortcuts`) registers normalized combos like "mod+shift+t"; this
 * module owns what the user is shown, so a registration and its label can
 * never drift. It carries the whole inventory (global, library, reader, PDF)
 * even where a surface does not render it yet, so the Settings reference can
 * list it without a backfill.
 *
 * Combos are engine strings. `mod` is Ctrl on Linux/Windows and Cmd on Mac.
 * Bare "+", "=" and "-" aliases, in-field Enter/Escape handling, and the
 * dev-only F12 / Ctrl+Shift+I are deliberately absent: they are not
 * user-facing shortcut bindings.
 */

export type ShortcutGroup = "global" | "library" | "reader" | "pdf";

export interface ReaderShortcut {
  /** Stable identifier for consumers and tests. */
  id: string;
  group: ShortcutGroup;
  /** Plain-language description of the action. */
  label: string;
  /** Engine combo strings; the first is the primary binding. */
  combos: string[];
}

/**
 * Panel shortcuts owned by `ReaderShell`. Registration reads these values,
 * and the toolbars' `aria-keyshortcuts` render them, so neither can drift
 * from the other.
 */
export const READER_PANEL_SHORTCUTS = {
  thumbnails: "mod+shift+t",
  appearance: "mod+shift+a",
  contents: "mod+shift+c",
  bookmarks: "mod+shift+b",
  highlights: "mod+shift+h",
} as const;

export const READER_SHORTCUTS: ReaderShortcut[] = [
  { id: "global.focus-search", group: "global", label: "Focus search", combos: ["mod+k"] },
  {
    id: "global.close-overlay",
    group: "global",
    label: "Close dialog or overlay",
    combos: ["escape"],
  },
  {
    id: "library.move-selection",
    group: "library",
    label: "Move selection",
    combos: ["arrowup", "arrowdown", "arrowleft", "arrowright"],
  },
  {
    id: "library.first-last",
    group: "library",
    label: "First or last book",
    combos: ["home", "end"],
  },
  { id: "library.open", group: "library", label: "Open selected book", combos: ["enter"] },
  {
    id: "reader.next",
    group: "reader",
    label: "Next page",
    combos: ["arrowright", "space", "pagedown"],
  },
  {
    id: "reader.previous",
    group: "reader",
    label: "Previous page",
    combos: ["arrowleft", "pageup"],
  },
  {
    id: "reader.first-last",
    group: "reader",
    label: "First or last page",
    combos: ["home", "end"],
  },
  { id: "reader.search", group: "reader", label: "Search in book", combos: ["mod+f"] },
  { id: "reader.bookmark", group: "reader", label: "Bookmark page", combos: ["mod+b"] },
  { id: "reader.presentation", group: "reader", label: "Presentation mode", combos: ["mod+l"] },
  {
    id: "reader.leave-presentation",
    group: "reader",
    label: "Leave presentation",
    combos: ["escape"],
  },
  {
    id: "pdf.thumbnails",
    group: "pdf",
    label: "Toggle page thumbnails",
    combos: [READER_PANEL_SHORTCUTS.thumbnails],
  },
  {
    id: "pdf.appearance",
    group: "pdf",
    label: "Toggle appearance",
    combos: [READER_PANEL_SHORTCUTS.appearance],
  },
  {
    id: "pdf.contents",
    group: "pdf",
    label: "Toggle contents drawer",
    combos: [READER_PANEL_SHORTCUTS.contents],
  },
  {
    id: "pdf.bookmarks",
    group: "pdf",
    label: "Open bookmarks",
    combos: [READER_PANEL_SHORTCUTS.bookmarks],
  },
  {
    id: "pdf.highlights",
    group: "pdf",
    label: "Open highlights",
    combos: [READER_PANEL_SHORTCUTS.highlights],
  },
  { id: "pdf.zoom-in", group: "pdf", label: "Zoom in", combos: ["mod+="] },
  { id: "pdf.zoom-out", group: "pdf", label: "Zoom out", combos: ["mod+-"] },
  { id: "pdf.zoom-reset", group: "pdf", label: "Reset zoom", combos: ["mod+0"] },
  { id: "pdf.fit-page", group: "pdf", label: "Fit page", combos: ["mod+1"] },
  { id: "pdf.fit-width", group: "pdf", label: "Fit width", combos: ["mod+2"] },
  { id: "pdf.fit-auto", group: "pdf", label: "Fit auto", combos: ["mod+3"] },
  {
    id: "pdf.reverse-flip",
    group: "pdf",
    label: "Reverse page flip in presentation",
    combos: ["shift+space"],
  },
];

const KEY_NAMES: Record<string, string> = {
  space: "Space",
  escape: "Escape",
  enter: "Enter",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
};

/** True on macOS, where `mod` renders as Cmd/Meta. */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform ?? "";
  if (platform !== "") return /mac/i.test(platform);
  return /mac/i.test(navigator.userAgent ?? "");
}

function keyName(token: string): string {
  return KEY_NAMES[token] ?? token.toUpperCase();
}

/** Human-readable combo, e.g. "Ctrl+Shift+T" or "Cmd+Shift+T". */
export function formatShortcutDisplay(combo: string, mac: boolean = isMacPlatform()): string {
  return combo
    .split("+")
    .map((token) => {
      if (token === "mod") return mac ? "Cmd" : "Ctrl";
      if (token === "shift") return "Shift";
      return keyName(token);
    })
    .join("+");
}

/** ARIA `keyshortcuts` value, e.g. "Control+Shift+T" or "Meta+Shift+T". */
export function formatShortcutAria(combo: string, mac: boolean = isMacPlatform()): string {
  return combo
    .split("+")
    .map((token) => {
      if (token === "mod") return mac ? "Meta" : "Control";
      if (token === "shift") return "Shift";
      return keyName(token);
    })
    .join("+");
}
