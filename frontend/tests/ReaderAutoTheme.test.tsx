import { beforeEach, describe, expect, it } from "vite-plus/test";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { readReaderSettings, writeReaderSettings } from "@/lib/readerSettings";
import type { ResolvedTheme } from "@/lib/theme";
import { ReaderProvider } from "@/state/ReaderProvider";
import { autoReaderTheme, DEFAULT_READER_PREFERENCES, useReader } from "@/state/readerState";

function Probe() {
  const { preferences, effectiveTheme, setPreferences } = useReader();
  return (
    <div>
      <span data-testid="theme">{preferences.theme}</span>
      <span data-testid="effective-theme">{effectiveTheme}</span>
      <span data-testid="foreground">{preferences.foreground ?? "none"}</span>
      <button type="button" onClick={() => setPreferences({ theme: "paper" })}>
        pick-paper
      </button>
      <button type="button" onClick={() => setPreferences({ theme: "default" })}>
        pick-default
      </button>
      <button type="button" onClick={() => setPreferences({ theme: "light" })}>
        pick-light
      </button>
      <button type="button" onClick={() => setPreferences({ theme: "contrast" })}>
        pick-contrast
      </button>
      <button type="button" onClick={() => setPreferences({ lineHeight: 1.5 })}>
        patch-line-height
      </button>
      <button type="button" onClick={() => setPreferences({ foreground: "#f5efe0" })}>
        pick-parchment-ink
      </button>
    </div>
  );
}

function renderReader(globalTheme: ResolvedTheme) {
  const rerenderWith = (next: ResolvedTheme) =>
    act(() => {
      rerender(
        <ReaderProvider globalTheme={next}>
          <Probe />
        </ReaderProvider>,
      );
    });
  const { rerender } = render(
    <ReaderProvider globalTheme={globalTheme}>
      <Probe />
    </ReaderProvider>,
  );
  return { rerenderWith };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("autoReaderTheme", () => {
  it("maps the global resolved theme onto the reader surface", () => {
    expect(autoReaderTheme("dark")).toBe("dark");
    expect(autoReaderTheme("light")).toBe("default");
  });
});

describe("ReaderProvider global theme following", () => {
  it("opens a dark surface from Default when the global theme is dark", () => {
    renderReader("dark");
    expect(screen.getByTestId("theme")).toHaveTextContent("default");
    expect(screen.getByTestId("effective-theme")).toHaveTextContent("dark");
  });

  it("keeps publisher colors from Default when the global theme is light", () => {
    renderReader("light");
    expect(screen.getByTestId("theme")).toHaveTextContent("default");
    expect(screen.getByTestId("effective-theme")).toHaveTextContent("default");
  });

  it("follows a live global flip while no theme is pinned", () => {
    const { rerenderWith } = renderReader("light");
    expect(screen.getByTestId("effective-theme")).toHaveTextContent("default");

    rerenderWith("dark");
    expect(screen.getByTestId("effective-theme")).toHaveTextContent("dark");

    rerenderWith("light");
    expect(screen.getByTestId("effective-theme")).toHaveTextContent("default");
  });

  it("pins an explicit theme pick against further global flips", async () => {
    const { rerenderWith } = renderReader("dark");
    await userEvent.click(screen.getByRole("button", { name: "pick-paper" }));

    rerenderWith("light");
    expect(screen.getByTestId("theme")).toHaveTextContent("paper");
    expect(screen.getByTestId("effective-theme")).toHaveTextContent("paper");
  });

  it("keeps Default following the app theme when explicitly pinned", async () => {
    const { rerenderWith } = renderReader("light");
    await userEvent.click(screen.getByRole("button", { name: "pick-default" }));
    expect(screen.getByTestId("effective-theme")).toHaveTextContent("default");

    rerenderWith("dark");
    // The menu still shows Default, but the applied surface follows dark.
    expect(screen.getByTestId("theme")).toHaveTextContent("default");
    expect(screen.getByTestId("effective-theme")).toHaveTextContent("dark");
  });

  it("stays unpinned when a patch does not touch the theme", async () => {
    const { rerenderWith } = renderReader("light");
    await userEvent.click(screen.getByRole("button", { name: "patch-line-height" }));

    rerenderWith("dark");
    expect(screen.getByTestId("effective-theme")).toHaveTextContent("dark");
  });

  it("drops a bright foreground override when the theme switches to a light surface", async () => {
    // UAT: global dark, override picked on the dark surface, then the user
    // switches to Light — the bright ink must not color body text on the
    // white page.
    renderReader("dark");
    await userEvent.click(screen.getByRole("button", { name: "pick-parchment-ink" }));
    expect(screen.getByTestId("foreground")).toHaveTextContent("#f5efe0");

    await userEvent.click(screen.getByRole("button", { name: "pick-light" }));
    expect(screen.getByTestId("foreground")).toHaveTextContent("none");
  });

  it("keeps a foreground override across a theme switch it still fits", async () => {
    renderReader("dark");
    await userEvent.click(screen.getByRole("button", { name: "pick-parchment-ink" }));

    // Contrast is still a dark-family surface; the override survives.
    await userEvent.click(screen.getByRole("button", { name: "pick-contrast" }));
    expect(screen.getByTestId("foreground")).toHaveTextContent("#f5efe0");
  });

  it("exposes a concrete theme (publisher default) without a global provider", () => {
    render(
      <ReaderProvider>
        <Probe />
      </ReaderProvider>,
    );
    expect(screen.getByTestId("theme")).toHaveTextContent("default");
    expect(screen.getByTestId("effective-theme")).toHaveTextContent("default");
  });

  it("adopts a theme written by Settings and never overwrites it with stale state", async () => {
    renderReader("light");
    expect(screen.getByTestId("effective-theme")).toHaveTextContent("default");

    // Settings edits the shared store directly while this reader is open.
    act(() => {
      writeReaderSettings({
        preferences: { ...DEFAULT_READER_PREFERENCES, theme: "paper" },
        themePinned: true,
      });
    });
    expect(screen.getByTestId("theme")).toHaveTextContent("paper");
    expect(screen.getByTestId("effective-theme")).toHaveTextContent("paper");

    // A later reader edit starts from the stored theme, not the stale one.
    await userEvent.click(screen.getByRole("button", { name: "patch-line-height" }));
    const stored = readReaderSettings();
    expect(stored.preferences.theme).toBe("paper");
    expect(stored.preferences.lineHeight).toBe(1.5);
  });
});
