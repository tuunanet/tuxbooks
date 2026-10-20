import { afterEach, describe, expect, it } from "vitest";

import {
  formatShortcutAria,
  formatShortcutDisplay,
  isMacPlatform,
  READER_PANEL_SHORTCUTS,
  READER_SHORTCUTS,
  type ShortcutGroup,
} from "@/lib/readerShortcuts";

const ALL_COMBOS = READER_SHORTCUTS.flatMap((shortcut) => shortcut.combos);

function shortcut(id: string) {
  const found = READER_SHORTCUTS.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing shortcut ${id}`);
  return found;
}

describe("READER_SHORTCUTS", () => {
  it("groups the inventory into global, library, reader, and pdf", () => {
    const groups = new Set<ShortcutGroup>(READER_SHORTCUTS.map((shortcut) => shortcut.group));
    expect([...groups].sort()).toEqual(["global", "library", "pdf", "reader"]);
  });

  it("lists the global and library bindings", () => {
    expect(shortcut("global.focus-search").combos).toEqual(["mod+k"]);
    expect(shortcut("global.close-overlay").combos).toEqual(["escape"]);
    expect(shortcut("library.move-selection").combos).toEqual([
      "arrowup",
      "arrowdown",
      "arrowleft",
      "arrowright",
    ]);
    expect(shortcut("library.first-last").combos).toEqual(["home", "end"]);
    expect(shortcut("library.open").combos).toEqual(["enter"]);
  });

  it("lists the reader bindings shared by both formats", () => {
    expect(shortcut("reader.next").label).toBe("Next page or section");
    expect(shortcut("reader.previous").label).toBe("Previous page or section");
    expect(shortcut("reader.next").combos).toEqual(["arrowright", "space", "pagedown"]);
    expect(shortcut("reader.previous").combos).toEqual(["arrowleft", "pageup"]);
    expect(shortcut("reader.first-last").combos).toEqual(["home", "end"]);
    expect(shortcut("reader.search").combos).toEqual(["mod+f"]);
    expect(shortcut("reader.bookmark").combos).toEqual(["mod+b"]);
    expect(shortcut("reader.presentation").combos).toEqual(["mod+l"]);
    expect(shortcut("reader.leave-presentation").combos).toEqual(["escape"]);
  });

  it("scopes each panel entry to the formats where it works", () => {
    expect(shortcut("pdf.thumbnails").group).toBe("pdf");
    expect(shortcut("pdf.thumbnails").combos).toEqual([READER_PANEL_SHORTCUTS.thumbnails]);
    for (const [id, combo] of [
      ["reader.appearance", READER_PANEL_SHORTCUTS.appearance],
      ["reader.contents", READER_PANEL_SHORTCUTS.contents],
      ["reader.bookmarks", READER_PANEL_SHORTCUTS.bookmarks],
      ["reader.highlights", READER_PANEL_SHORTCUTS.highlights],
    ] as const) {
      expect(shortcut(id).group).toBe("reader");
      expect(shortcut(id).combos).toEqual([combo]);
    }
    expect(READER_PANEL_SHORTCUTS).toEqual({
      thumbnails: "mod+shift+t",
      appearance: "mod+shift+a",
      contents: "mod+shift+c",
      bookmarks: "mod+shift+b",
      highlights: "mod+shift+h",
    });
  });

  it("keeps only the PDF-only bindings in the pdf group", () => {
    const pdfIds = READER_SHORTCUTS.filter((entry) => entry.group === "pdf").map(
      (entry) => entry.id,
    );
    expect(new Set(pdfIds)).toEqual(
      new Set([
        "pdf.thumbnails",
        "pdf.zoom-in",
        "pdf.zoom-out",
        "pdf.zoom-reset",
        "pdf.fit-page",
        "pdf.fit-width",
        "pdf.fit-auto",
        "pdf.reverse-flip",
      ]),
    );
  });

  it("lists the remaining PDF bindings", () => {
    expect(shortcut("pdf.zoom-in").combos).toEqual(["mod+="]);
    expect(shortcut("pdf.zoom-out").combos).toEqual(["mod+-"]);
    expect(shortcut("pdf.zoom-reset").combos).toEqual(["mod+0"]);
    expect(shortcut("pdf.fit-page").combos).toEqual(["mod+1"]);
    expect(shortcut("pdf.fit-width").combos).toEqual(["mod+2"]);
    expect(shortcut("pdf.fit-auto").combos).toEqual(["mod+3"]);
    expect(shortcut("pdf.reverse-flip").combos).toEqual(["shift+space"]);
  });

  it("omits bare aliases, in-field keys, and dev-only bindings", () => {
    const excluded = ["+", "=", "-", "f12", "mod+shift+i"];
    for (const combo of excluded) {
      expect(ALL_COMBOS).not.toContain(combo);
    }
  });

  it("gives every shortcut a label and at least one combo", () => {
    for (const entry of READER_SHORTCUTS) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.combos.length).toBeGreaterThan(0);
    }
  });
});

describe("shortcut formatting", () => {
  it("renders display combos with Ctrl or Cmd", () => {
    expect(formatShortcutDisplay("mod+shift+t", false)).toBe("Ctrl+Shift+T");
    expect(formatShortcutDisplay("mod+shift+t", true)).toBe("Cmd+Shift+T");
    expect(formatShortcutDisplay("mod+k", false)).toBe("Ctrl+K");
  });

  it("renders aria combos with Control or Meta and canonical key names", () => {
    expect(formatShortcutAria("mod+shift+t", false)).toBe("Control+Shift+T");
    expect(formatShortcutAria("mod+shift+t", true)).toBe("Meta+Shift+T");
    expect(formatShortcutAria("space", false)).toBe("Space");
    expect(formatShortcutAria("arrowleft", false)).toBe("ArrowLeft");
    expect(formatShortcutAria("pagedown", false)).toBe("PageDown");
    expect(formatShortcutAria("escape", false)).toBe("Escape");
    expect(formatShortcutAria("shift+space", false)).toBe("Shift+Space");
  });
});

describe("isMacPlatform", () => {
  const original = Object.getOwnPropertyDescriptor(navigator, "platform");
  afterEach(() => {
    if (original) Object.defineProperty(navigator, "platform", original);
    else Reflect.deleteProperty(navigator, "platform");
  });

  it("detects the Mac platform from navigator and defaults the formatters", () => {
    Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
    expect(isMacPlatform()).toBe(true);
    expect(formatShortcutDisplay("mod+shift+a")).toBe("Cmd+Shift+A");
    expect(formatShortcutAria("mod+shift+a")).toBe("Meta+Shift+A");
  });

  it("treats non-Mac platforms as Ctrl/Control", () => {
    Object.defineProperty(navigator, "platform", { value: "Linux x86_64", configurable: true });
    expect(isMacPlatform()).toBe(false);
    expect(formatShortcutDisplay("mod+shift+a")).toBe("Ctrl+Shift+A");
    expect(formatShortcutAria("mod+shift+a")).toBe("Control+Shift+A");
  });
});
