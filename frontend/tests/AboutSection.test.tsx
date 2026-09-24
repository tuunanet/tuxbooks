import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AboutSection } from "@/components/settings/AboutSection";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { ImportProvider } from "@/state/ImportProvider";
import { LibraryDataProvider } from "@/state/LibraryDataProvider";
import { ThemeStateProvider } from "@/state/ThemeStateProvider";
import { mockInvoke } from "./mocks/bridge";

const CONTRIBUTORS_URL = "https://github.com/tuunanet/tuxbooks/blob/main/CONTRIBUTORS.md";
const CONTRIBUTING_URL = "https://github.com/tuunanet/tuxbooks/blob/main/CONTRIBUTING.md";

describe("AboutSection", () => {
  it("shows the app name, version, and creator credit", () => {
    render(<AboutSection />);

    const rows = screen.getByTestId("settings-rows");
    expect(rows).toHaveTextContent(`TuxBooks ${__TUXBOOKS_VERSION__}`);
    expect(rows).toHaveTextContent("Created by Tuomo Tuunanen (2026–)");
  });

  it("links to the contributor docs on the main branch", () => {
    render(<AboutSection />);

    const contributors = screen.getByRole("link", { name: /Contributors/ });
    expect(contributors).toHaveAttribute("href", CONTRIBUTORS_URL);
    expect(contributors).toHaveTextContent("Full list of contributors");

    const contributing = screen.getByRole("link", { name: /Contributing/ });
    expect(contributing).toHaveAttribute("href", CONTRIBUTING_URL);
    expect(contributing).toHaveTextContent("How to contribute");
  });

  it("renders inside the settings shell when About is selected", async () => {
    mockInvoke({
      get_library_stats: { bookCount: 0, collectionCount: 0 },
      list_books: [],
      list_collections: [],
    });
    render(
      <ThemeStateProvider>
        <LibraryDataProvider>
          <ImportProvider>
            <SettingsShell onSelectSection={() => {}} />
          </ImportProvider>
        </LibraryDataProvider>
      </ThemeStateProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "About" }));
    expect(screen.getByRole("heading", { name: "About" })).toBeInTheDocument();
    expect(screen.getByTestId("settings-rows")).toHaveTextContent(
      "Created by Tuomo Tuunanen (2026–)",
    );
    expect(screen.getByRole("link", { name: /Contributors/ })).toHaveAttribute(
      "href",
      CONTRIBUTORS_URL,
    );
  });
});
