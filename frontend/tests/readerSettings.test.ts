import { describe, expect, it, beforeEach } from "vitest";

import {
  clearReaderSettings,
  defaultReaderSettings,
  effectiveReaderPreferences,
  readReaderSettings,
  READER_SETTINGS_STORAGE_KEY,
  sanitizeReaderPreferences,
  writeReaderSettings,
} from "@/lib/readerSettings";
import { DEFAULT_READER_PREFERENCES } from "@/state/readerState";

beforeEach(() => {
  window.localStorage.clear();
});

describe("readerSettings persistence", () => {
  it("defaults when nothing is stored", () => {
    const settings = readReaderSettings();
    expect(settings.preferences).toEqual(DEFAULT_READER_PREFERENCES);
    expect(settings.themePinned).toBe(false);
  });

  it("round-trips written settings", () => {
    const stored = {
      preferences: {
        ...DEFAULT_READER_PREFERENCES,
        layout: "scrolling" as const,
        theme: "paper" as const,
      },
      themePinned: true,
    };
    writeReaderSettings(stored);

    const read = readReaderSettings();
    expect(read.preferences.layout).toBe("scrolling");
    expect(read.preferences.theme).toBe("paper");
    expect(read.themePinned).toBe(true);
  });

  it("clears back to defaults", () => {
    writeReaderSettings({ ...defaultReaderSettings(), themePinned: true });
    clearReaderSettings();
    expect(window.localStorage.getItem(READER_SETTINGS_STORAGE_KEY)).toBeNull();
    expect(readReaderSettings().themePinned).toBe(false);
  });

  it("recovers from corrupt JSON", () => {
    window.localStorage.setItem(READER_SETTINGS_STORAGE_KEY, "{ not json");
    expect(readReaderSettings().preferences).toEqual(DEFAULT_READER_PREFERENCES);
  });

  it("snaps off-scale and invalid values back to supported ones", () => {
    const settings = sanitizeReaderPreferences({
      epubFontSize: 12345,
      lineHeight: 0.9,
      columnCount: 9,
      wordSpacing: -5,
      textAlign: "middle",
      fontFamily: "comic-sans",
      foreground: "not-a-color",
      theme: "neon",
      layout: "horizontal",
    });
    expect(settings.epubFontSize).toBe(400);
    expect(settings.lineHeight).toBe(1);
    expect(settings.columnCount).toBe(4);
    expect(settings.wordSpacing).toBe(0);
    expect(settings.textAlign).toBe(DEFAULT_READER_PREFERENCES.textAlign);
    expect(settings.fontFamily).toBeNull();
    expect(settings.foreground).toBeNull();
    expect(settings.theme).toBe(DEFAULT_READER_PREFERENCES.theme);
    expect(settings.layout).toBe(DEFAULT_READER_PREFERENCES.layout);
  });

  it("normalizes a valid foreground to lower case", () => {
    const settings = sanitizeReaderPreferences({ foreground: "#AABBCC" });
    expect(settings.foreground).toBe("#aabbcc");
  });
});

describe("effectiveReaderPreferences", () => {
  it("follows the global theme while the reader theme is unpinned", () => {
    const settings = {
      preferences: { ...DEFAULT_READER_PREFERENCES, theme: "paper" as const },
      themePinned: false,
    };
    expect(effectiveReaderPreferences(settings, "dark").theme).toBe("dark");
    expect(effectiveReaderPreferences(settings, "light").theme).toBe("default");
  });

  it("keeps the explicit theme once pinned", () => {
    const settings = {
      preferences: { ...DEFAULT_READER_PREFERENCES, theme: "paper" as const },
      themePinned: true,
    };
    expect(effectiveReaderPreferences(settings, "dark").theme).toBe("paper");
  });
});
