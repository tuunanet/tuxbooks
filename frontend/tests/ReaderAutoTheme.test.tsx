import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ResolvedTheme } from "@/lib/theme";
import { ReaderProvider } from "@/state/ReaderProvider";
import { autoReaderTheme, useReader } from "@/state/readerState";

function Probe() {
  const { preferences, setPreferences } = useReader();
  return (
    <div>
      <span data-testid="theme">{preferences.theme}</span>
      <span data-testid="foreground">{preferences.foreground ?? "none"}</span>
      <button type="button" onClick={() => setPreferences({ theme: "paper" })}>
        pick-paper
      </button>
      <button type="button" onClick={() => setPreferences({ theme: "default" })}>
        pick-default
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
  it("opens a dark surface when the global theme is dark", () => {
    renderReader("dark");
    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
  });

  it("keeps publisher colors when the global theme is light", () => {
    renderReader("light");
    expect(screen.getByTestId("theme")).toHaveTextContent("default");
  });

  it("follows a live global flip while no theme is pinned", () => {
    const { rerenderWith } = renderReader("light");
    expect(screen.getByTestId("theme")).toHaveTextContent("default");

    rerenderWith("dark");
    expect(screen.getByTestId("theme")).toHaveTextContent("dark");

    rerenderWith("light");
    expect(screen.getByTestId("theme")).toHaveTextContent("default");
  });

  it("pins an explicit theme pick against further global flips", async () => {
    const { rerenderWith } = renderReader("dark");
    await userEvent.click(screen.getByRole("button", { name: "pick-paper" }));

    rerenderWith("light");
    expect(screen.getByTestId("theme")).toHaveTextContent("paper");
  });

  it("lets an explicit Default pick hold publisher colors in global dark", async () => {
    const { rerenderWith } = renderReader("light");
    await userEvent.click(screen.getByRole("button", { name: "pick-default" }));

    rerenderWith("dark");
    expect(screen.getByTestId("theme")).toHaveTextContent("default");
  });

  it("stays unpinned when a patch does not touch the theme", async () => {
    const { rerenderWith } = renderReader("light");
    await userEvent.click(screen.getByRole("button", { name: "patch-line-height" }));

    rerenderWith("dark");
    expect(screen.getByTestId("theme")).toHaveTextContent("dark");
  });

  it("drops a bright foreground override when the theme switches to a light surface", async () => {
    // UAT: global dark, override picked on the dark surface, then the user
    // switches to Default (publisher white) — the bright ink must not
    // color body text on the white page.
    renderReader("dark");
    await userEvent.click(screen.getByRole("button", { name: "pick-parchment-ink" }));
    expect(screen.getByTestId("foreground")).toHaveTextContent("#f5efe0");

    await userEvent.click(screen.getByRole("button", { name: "pick-default" }));
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
  });
});
