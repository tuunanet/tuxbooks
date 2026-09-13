import { describe, expect, it } from "vitest";

import {
  applyTheme,
  parseStoredTheme,
  resolveTheme,
  subscribeToSystemTheme,
  systemPrefersDark,
  THEME_STORAGE_KEY,
} from "@/lib/theme";

type ChangeListener = (event: { matches: boolean }) => void;

interface FakeMedia {
  matches: boolean;
  listeners: Set<ChangeListener>;
}

function fakeWindow(dark: boolean): { win: Window; media: FakeMedia } {
  const media: FakeMedia = { matches: dark, listeners: new Set() };
  const win = {
    matchMedia: (query: string) =>
      ({
        matches: media.matches,
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: ChangeListener) => {
          media.listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: ChangeListener) => {
          media.listeners.delete(listener);
        },
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  };
  return { win: win as unknown as Window, media };
}

function fireChange(media: FakeMedia, dark: boolean): void {
  media.matches = dark;
  for (const listener of [...media.listeners]) listener({ matches: dark });
}

describe("parseStoredTheme", () => {
  it("maps stored values to preferences", () => {
    expect(parseStoredTheme("system")).toBe("system");
    expect(parseStoredTheme("light")).toBe("light");
    expect(parseStoredTheme("dark")).toBe("dark");
  });

  it("falls back to system on missing or corrupt values", () => {
    expect(parseStoredTheme(null)).toBe("system");
    expect(parseStoredTheme("")).toBe("system");
    expect(parseStoredTheme("DARK")).toBe("system");
    expect(parseStoredTheme("neon")).toBe("system");
  });

  it("uses the agreed storage key", () => {
    expect(THEME_STORAGE_KEY).toBe("tuxbooks.theme");
  });
});

describe("resolveTheme", () => {
  it("resolves system against the OS setting", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("lets explicit choices win over the OS", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("light", false)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("applyTheme", () => {
  it("toggles the dark class and color-scheme on the document element", () => {
    applyTheme("dark", document);
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    applyTheme("light", document);
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });
});

describe("systemPrefersDark", () => {
  it("reads the OS color-scheme media query", () => {
    expect(systemPrefersDark(fakeWindow(true).win)).toBe(true);
    expect(systemPrefersDark(fakeWindow(false).win)).toBe(false);
  });

  it("treats a missing matchMedia as light", () => {
    const win = {} as unknown as Window;
    expect(systemPrefersDark(win)).toBe(false);
  });
});

describe("subscribeToSystemTheme", () => {
  it("reports live OS flips and stops after unsubscribing", () => {
    const { win, media } = fakeWindow(false);
    const seen: boolean[] = [];
    const unsubscribe = subscribeToSystemTheme(win, (dark) => seen.push(dark));

    fireChange(media, true);
    fireChange(media, false);
    expect(seen).toEqual([true, false]);

    unsubscribe();
    fireChange(media, true);
    expect(seen).toEqual([true, false]);
  });

  it("returns a no-op unsubscribe when matchMedia is missing", () => {
    const win = {} as unknown as Window;
    expect(subscribeToSystemTheme(win, () => {})).toBeTypeOf("function");
  });
});
