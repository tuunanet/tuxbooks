import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { THEME_STORAGE_KEY } from "@/lib/theme";
import { ThemeStateProvider } from "@/state/ThemeStateProvider";
import { useThemeState } from "@/state/themeState";

type ChangeListener = (event: { matches: boolean }) => void;

/**
 * Controllable stand-in for the OS color-scheme media query; the setup.ts
 * fallback matchMedia exists but its listeners never fire.
 */
function installMatchMedia(initialDark: boolean) {
  const listeners = new Set<ChangeListener>();
  const media = {
    matches: initialDark,
    addEventListener: (_type: string, listener: ChangeListener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: ChangeListener) => {
      listeners.delete(listener);
    },
  };
  window.matchMedia = ((query: string) =>
    query === "(prefers-color-scheme: dark)"
      ? media
      : {
          matches: false,
          media: query,
          onchange: null,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as typeof window.matchMedia;
  return {
    flip(dark: boolean) {
      media.matches = dark;
      for (const listener of [...listeners]) listener({ matches: dark });
    },
  };
}

function Probe() {
  const { preference, resolvedTheme, setPreference } = useThemeState();
  return (
    <div>
      <span data-testid="preference">{preference}</span>
      <span data-testid="resolved">{resolvedTheme}</span>
      <button type="button" onClick={() => setPreference("system")}>
        system
      </button>
      <button type="button" onClick={() => setPreference("light")}>
        light
      </button>
      <button type="button" onClick={() => setPreference("dark")}>
        dark
      </button>
    </div>
  );
}

function renderProvider() {
  return render(
    <ThemeStateProvider>
      <Probe />
    </ThemeStateProvider>,
  );
}

beforeEach(() => {
  installMatchMedia(false);
  window.localStorage.clear();
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
});

describe("ThemeStateProvider", () => {
  it("defaults to system and paints the resolved OS theme", async () => {
    renderProvider();

    expect(await screen.findByTestId("preference")).toHaveTextContent("system");
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("follows a live OS flip while on system", async () => {
    const os = installMatchMedia(false);
    renderProvider();
    await screen.findByTestId("resolved");

    act(() => os.flip(true));

    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    expect(document.documentElement).toHaveClass("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("persists an explicit choice and stops following the OS", async () => {
    const os = installMatchMedia(false);
    renderProvider();
    await screen.findByTestId("resolved");

    await userEvent.click(screen.getByRole("button", { name: "dark" }));
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement).toHaveClass("dark");

    act(() => os.flip(false));
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
  });

  it("restores the stored preference after a remount", async () => {
    const first = renderProvider();
    await screen.findByTestId("resolved");
    await userEvent.click(screen.getByRole("button", { name: "dark" }));
    first.unmount();

    // Fresh mount (simulated restart): OS is light, stored choice is dark.
    renderProvider();

    expect(await screen.findByTestId("resolved")).toHaveTextContent("dark");
    expect(document.documentElement).toHaveClass("dark");
  });

  it("treats corrupt stored values as system", () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, "neon");

    renderProvider();

    expect(screen.getByTestId("preference")).toHaveTextContent("system");
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
  });

  it("re-reads the OS when returning to system after flips while pinned", async () => {
    const os = installMatchMedia(false);
    renderProvider();
    await screen.findByTestId("resolved");

    // OS flips while the app is pinned to light: the stale systemDark must
    // not leak when the user switches back to system.
    act(() => os.flip(true));
    await userEvent.click(screen.getByRole("button", { name: "light" }));
    act(() => os.flip(false));
    await userEvent.click(screen.getByRole("button", { name: "system" }));

    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });
});
