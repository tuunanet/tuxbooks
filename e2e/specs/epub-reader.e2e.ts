import { expect, test, type Page } from "../fixtures/electron-app.js";

import {
  closeReaderNavigation,
  epubLocator,
  openInReader,
  returnToLibrary,
  textOf,
} from "./helpers.js";

/** Waits until the EPUB engine reports the given spine section. */
async function waitForSection(page: Page, section: number): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          document
            .querySelector("[data-testid=epub-reader] [data-epub-host]")
            ?.getAttribute("data-epub-section"),
        ),
      { timeout: 30000, message: `epub engine never reached section ${section}` },
    )
    .toBe(String(section));
}

/** Current spine section reported by the engine host, or null before init. */
async function currentSection(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document
        .querySelector("[data-testid=epub-reader] [data-epub-host]")
        ?.getAttribute("data-epub-section") ?? null,
  );
}

/** In-section progression (0..1) reported by the engine host. */
async function engineFraction(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document
        .querySelector("[data-testid=epub-reader] [data-epub-host]")
        ?.getAttribute("data-epub-fraction") ?? null,
  );
}

/**
 * True when the engine sits strictly past `(section, fraction)` in spine
 * order: a later section, or the same section at a larger fraction.
 */
async function engineMovedPast(page: Page, section: number, fraction: string): Promise<boolean> {
  const current = await currentSection(page);
  if (current === null) return false;
  const currentSectionIndex = Number(current);
  if (Number.isNaN(currentSectionIndex)) return false;
  if (currentSectionIndex !== section) return currentSectionIndex > section;
  const currentFraction = Number((await engineFraction(page)) ?? "0");
  return currentFraction > Number(fraction);
}

/** Opens the minimal EPUB and waits for the engine to report ready. */
async function openReadyEpub(page: Page): Promise<void> {
  await openInReader(page, "A Minimal Book (EPUB)");
  const host = page.locator("div[data-epub-host]");
  await host.waitFor({ state: "attached", timeout: 30000 });
  await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });
}

/** Opens the contents drawer and jumps to the given TOC entry. */
async function jumpToTocItem(page: Page, index: number): Promise<void> {
  await page.getByTestId("reader-nav-trigger").click();
  const item = page.getByTestId(`toc-item-${index}`);
  await expect(item).toBeVisible({ timeout: 30000 });
  await item.click();
}

test.describe("tuxbooks EPUB reader", () => {
  test("opens the fixture and renders it through the engine", async ({ page }) => {
    await openReadyEpub(page);
    // The shell footer tracks the engine's progression (starts at the top).
    await expect
      .poll(() => textOf(page, "reader-position"), { timeout: 30000 })
      .toMatch(/^(100|[1-9]?\d)%$/);

    // The navigator's section iframes must fill the navigator container.
    // The toolkit mounts them without dimensions; a host app that loses the
    // sizing stylesheet renders the book as a 300x150 block in the top-left
    // corner while every state attribute stays honest (regression).
    const frames = await page.evaluate(() => {
      const container = document.querySelector("[data-epub-host]")?.firstElementChild;
      const containerRect = container?.getBoundingClientRect();
      return [...document.querySelectorAll("iframe.readium-navigator-iframe")].map((frame) => {
        const rect = frame.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          containerWidth: containerRect?.width ?? 0,
          containerHeight: containerRect?.height ?? 0,
        };
      });
    });
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame.containerWidth).toBeGreaterThan(0);
      expect(frame.containerHeight).toBeGreaterThan(0);
      expect(frame.width).toBeGreaterThan(frame.containerWidth * 0.95);
      expect(frame.height).toBeGreaterThan(frame.containerHeight * 0.95);
    }

    await returnToLibrary(page);
  });

  test("navigates chapters from the contents drawer", async ({ page }) => {
    await openReadyEpub(page);
    expect(await currentSection(page)).toBe("0");

    await jumpToTocItem(page, 2);
    await waitForSection(page, 2);
    await page.getByTestId("reader-nav").waitFor({ state: "detached", timeout: 30000 });

    await returnToLibrary(page);
  });

  // Regression: the shell used to keep its percentage-stepping arrow
  // handlers registered for EPUB, where the step is 100/0 (no page count)
  // and the provider clamps straight to 100%/0% — one ArrowRight landed on
  // the end of the document. Arrows must drive the engine's page turns:
  // asserted on the engine's pinned fraction/section attributes (exact
  // engine truth) rather than the interpolated shell percent.
  test("turns pages with the arrow keys through the engine", async ({ page }) => {
    await openReadyEpub(page);
    // Position may restore from an earlier test; start from the top.
    await page.keyboard.press("Home");
    await expect
      .poll(
        async () => ({
          section: await currentSection(page),
          fraction: await engineFraction(page),
          percent: await textOf(page, "reader-position"),
        }),
        { timeout: 30000 },
      )
      .toEqual({ section: "0", fraction: "0", percent: "0%" });

    await page.keyboard.press("ArrowRight");
    await expect.poll(() => engineMovedPast(page, 0, "0"), { timeout: 30000 }).toBe(true);
    const afterRight = {
      section: (await currentSection(page)) ?? "0",
      fraction: (await engineFraction(page)) ?? "0",
    };
    expect(parseInt(await textOf(page, "reader-position"), 10)).toBeLessThan(95);

    // One ArrowLeft must go back: the engine fraction/section must not sit
    // past where ArrowRight landed.
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(() => engineMovedPast(page, Number(afterRight.section), afterRight.fraction), {
        timeout: 30000,
      })
      .toBe(false);
  });

  // MathML in EPUB 3 renders natively via the browser engine; the fixture's
  // third chapter carries one formula.
  test("renders native MathML content", async ({ page }) => {
    await openReadyEpub(page);

    await jumpToTocItem(page, 2);
    await waitForSection(page, 2);

    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const host = document.querySelector("[data-epub-host]");
            for (const frame of host?.querySelectorAll("iframe") ?? []) {
              try {
                if ((frame.contentDocument?.querySelectorAll("math").length ?? 0) > 0) return true;
              } catch {
                continue;
              }
            }
            return false;
          }),
        { timeout: 30000 },
      )
      .toBe(true);

    await returnToLibrary(page);
  });

  test("applies appearance preferences to the reading surface", async ({ page }) => {
    await openReadyEpub(page);

    await page.getByTestId("appearance-trigger").click();
    await expect(page.getByTestId("appearance-content")).toBeVisible({ timeout: 30000 });
    // The appearance controls are Radix ToggleGroup items (role=radio) —
    // click by text within the group's stable test id, not by role.
    await page.getByTestId("pref-font-family").getByText("Serif", { exact: true }).click();
    await page.getByTestId("pref-theme").getByText("Paper", { exact: true }).click();

    // Font size walks the Readium percent scale (issue #42). The slider owns
    // its arrow keys, and larger text must repaginate cleanly while keeping
    // the reading location: the reader stays ready in the same spine
    // section. The book may open at a previously saved position (specs share
    // the scratch library), so assert preservation, not an absolute section.
    const fontSlider = page.getByTestId("pref-font-size").getByRole("slider");
    const host = page.locator("div[data-epub-host]");
    const sectionBefore = await currentSection(page);
    await fontSlider.press("ArrowRight");
    await fontSlider.press("ArrowRight");
    await expect(page.getByTestId("appearance-content")).toContainText("137.5%");
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });
    await expect.poll(() => currentSection(page), { timeout: 30000 }).toBe(sectionBefore);
    await fontSlider.press("ArrowLeft");
    await fontSlider.press("ArrowLeft");
    await expect(page.getByTestId("appearance-content")).toContainText("100%");
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });
    await expect.poll(() => currentSection(page), { timeout: 30000 }).toBe(sectionBefore);

    await page.getByTestId("pref-layout").getByText("Scrolling", { exact: true }).click();
    await expect(page.getByTestId("reader-view")).toHaveAttribute("data-theme", "paper", {
      timeout: 30000,
    });
    await expect(page.getByTestId("epub-reader")).toHaveAttribute("data-layout", "scrolling", {
      timeout: 30000,
    });

    // Close the popover so it cannot intercept the toolbar clicks below.
    await page.keyboard.press("Escape");
    await page.getByTestId("appearance-content").waitFor({ state: "detached", timeout: 30000 });

    // Scrolled-flow regression pin (issue #42 UAT): the toolkit stubs
    // go_next/go_prev in scrolled mode, which chapter-skips when the app
    // turns pages through the navigator. The seam scrolls one viewport
    // instead, so one ArrowRight may hold the section (fraction advanced)
    // or hop exactly one spine item for a short chapter — never two.
    const sectionBeforeScroll = await currentSection(page);
    await page.keyboard.press("ArrowRight");
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });
    await expect
      .poll(
        async () => {
          const section = await currentSection(page);
          return section === null ? null : Number(section) - Number(sectionBeforeScroll);
        },
        { timeout: 30000, message: "scrolled ArrowRight skipped chapters" },
      )
      .toBeLessThanOrEqual(1);
    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(
        async () => {
          const section = await currentSection(page);
          return section === null ? null : Number(section) - Number(sectionBeforeScroll);
        },
        { timeout: 30000, message: "scrolled ArrowLeft skipped chapters" },
      )
      .toBeGreaterThanOrEqual(-1);

    await returnToLibrary(page);
  });

  // Critical acceptance test (§ persistence): the reader resumes the saved
  // CFI location after the book is closed and reopened.
  test("restores the reading position when the EPUB is reopened", async ({ page }) => {
    await openReadyEpub(page);

    // Jump to Chapter Three via the contents drawer and let the debounced
    // save land before leaving the reader.
    await jumpToTocItem(page, 2);
    await waitForSection(page, 2);
    await page.waitForTimeout(1500);
    await returnToLibrary(page);

    // Reopen: the engine restores into Chapter Three (spine section 2).
    await openReadyEpub(page);
    await waitForSection(page, 2);
    const percent = await textOf(page, "reader-position");
    expect(parseInt(percent, 10)).toBeGreaterThan(30);

    await returnToLibrary(page);
  });

  // Semantic persistence regression (docs/TESTING.md): the exact engine
  // locator — not just the section index or a percentage — survives the
  // close/reopen cycle. This is the reading-position regression protection
  // the engine migration (foliate → Readium) must keep passing. The locator
  // grammar is the serialized Readium locator JSON; the restored locator
  // must name the same section at the same in-section progression.
  test("restores the exact locator across close and reopen", async ({ page }) => {
    await openReadyEpub(page);

    // Land on a known in-chapter position via the contents drawer.
    await jumpToTocItem(page, 1);
    await waitForSection(page, 1);
    await expect.poll(() => epubLocator(page), { timeout: 30000 }).not.toBeNull();
    const savedLocator = (await epubLocator(page)) ?? "{}";
    const saved = JSON.parse(savedLocator) as {
      href?: string;
      locations?: { progression?: number };
    };
    expect(saved.href).toContain("chapter2.xhtml");

    // Let the debounced save flush before leaving the reader.
    await page.waitForTimeout(1500);
    await returnToLibrary(page);

    // Reopen: the restored locator names the same logical content position
    // (same section, same in-section progression within a tolerance).
    await openReadyEpub(page);
    await expect.poll(() => epubLocator(page), { timeout: 30000 }).not.toBeNull();
    const restoredLocator = (await epubLocator(page)) ?? "{}";
    const restored = JSON.parse(restoredLocator) as {
      href?: string;
      locations?: { progression?: number };
    };
    expect(restored.href).toBe(saved.href);
    const savedProgression = saved.locations?.progression ?? 0;
    const restoredProgression = restored.locations?.progression ?? 0;
    expect(Math.abs(restoredProgression - savedProgression)).toBeLessThan(0.1);
    await waitForSection(page, 1);

    await returnToLibrary(page);
  });

  // Milestone 5 — in-book search: the drawer's Search tab streams matches
  // from the engine (query, count, excerpt, chapter) and navigating to a
  // match moves the engine to the match's CFI.
  test("finds text in the book and navigates to a match", async ({ page }) => {
    await openReadyEpub(page);

    // Move away from Chapter One so navigating to the match is observable.
    await jumpToTocItem(page, 2);
    await waitForSection(page, 2);
    await page.getByTestId("reader-nav").waitFor({ state: "detached", timeout: 30000 });

    await page.getByTestId("reader-search").click();
    const searchInput = page.getByTestId("reader-search-input");
    await expect(searchInput).toBeVisible({ timeout: 30000 });
    await searchInput.fill("deterministic");

    // "deterministic" occurs exactly once, in Chapter One's text.
    await expect(page.getByTestId("reader-search-match").first()).toBeVisible({
      timeout: 30000,
    });
    await expect(page.getByTestId("reader-search-status")).toContainText("1 match", {
      timeout: 30000,
    });
    const matchText = await page.evaluate(
      () => document.querySelector("[data-testid=reader-search-match]")?.textContent ?? "",
    );
    expect(matchText).toContain("deterministic");
    const resultsText = await page.evaluate(
      () => document.querySelector("[data-testid=reader-search-results]")?.textContent ?? "",
    );
    expect(resultsText).toContain("Chapter One");

    // Clicking the match drives the engine back to Chapter One (section 0);
    // the drawer stays open so the next hit is one click away.
    await page.getByTestId("reader-search-match").click();
    await waitForSection(page, 0);
    await expect(page.getByTestId("reader-nav")).toBeVisible();

    await closeReaderNavigation(page);
    await returnToLibrary(page);
  });
});
