import { expect, test, type Page } from "../fixtures/electron-app.js";

import { epubLocator, openInReader, returnToLibrary, textOf } from "./helpers.js";

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
    await expect
      .poll(() => textOf(page, "reader-position"), { timeout: 30000 })
      .toMatch(/^(100|[1-9]?\d)%$/);

    // Readium mounts section iframes without dimensions: losing the sizing stylesheet yields 300x150.
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

  // Arrows must drive the engine's page turns; assert on its own fraction/section, not shell percent.
  test("turns pages with the arrow keys through the engine", async ({ page }) => {
    await openReadyEpub(page);
    // Specs share the scratch library's saved positions; start from the top.
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

    await page.keyboard.press("ArrowLeft");
    await expect
      .poll(() => engineMovedPast(page, Number(afterRight.section), afterRight.fraction), {
        timeout: 30000,
      })
      .toBe(false);
  });

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
    await page.getByTestId("pref-font-family").getByText("Serif", { exact: true }).click();
    await page.getByTestId("pref-theme").getByText("Paper", { exact: true }).click();

    await expect
      .poll(() =>
        page.getByTestId("appearance-content").evaluate((el) => ({
          x: el.scrollWidth - el.clientWidth,
          y: el.scrollHeight - el.clientHeight,
        })),
      )
      .toEqual({ x: 0, y: 0 });

    const themeVar = (name: string) =>
      page
        .frameLocator("[data-epub-host] iframe")
        .first()
        .locator("html")
        .evaluate((el, styleName) => el.style.getPropertyValue(styleName), name);
    const sectionAtThemeSwitch = await currentSection(page);
    await expect
      .poll(() => themeVar("--USER__backgroundColor"), { timeout: 30000 })
      .toBe("#f6f0e4");
    await expect.poll(() => currentSection(page), { timeout: 30000 }).toBe(sectionAtThemeSwitch);

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

    await page.keyboard.press("Escape");
    await page.getByTestId("appearance-content").waitFor({ state: "detached", timeout: 30000 });

    // In scrolled flow the go_next/go_prev stubs chapter-skip: one ArrowRight may hop one spine item, never two.
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

    await expect
      .poll(() => themeVar("--USER__backgroundColor"), { timeout: 30000 })
      .toBe("#f6f0e4");
    await page.getByTestId("appearance-trigger").click();
    await expect(page.getByTestId("appearance-content")).toBeVisible({ timeout: 30000 });
    await page.getByTestId("pref-theme").getByText("Default", { exact: true }).click();
    await expect.poll(() => themeVar("--USER__backgroundColor"), { timeout: 30000 }).toBe("");

    await page.keyboard.press("Escape");
    await page.getByTestId("appearance-content").waitFor({ state: "detached", timeout: 30000 });
    await returnToLibrary(page);
  });

  test("targets an explicit column count in paginated flow", async ({ page }) => {
    await openReadyEpub(page);
    const host = page.locator("div[data-epub-host]");
    await page.getByTestId("appearance-trigger").click();
    await expect(page.getByTestId("appearance-content")).toBeVisible({ timeout: 30000 });

    const colCountInFrame = () =>
      page
        .frameLocator("[data-epub-host] iframe")
        .first()
        .locator("html")
        .evaluate((el) => el.style.getPropertyValue("--USER__colCount"));

    const columns = page.getByTestId("pref-columns");
    await expect(columns.getByRole("radio", { name: "One column" })).toBeVisible();
    await expect(columns.getByRole("radio", { name: "4 columns" })).toBeVisible();
    await expect(columns.getByRole("radio", { name: "2 columns" })).toHaveAttribute(
      "data-state",
      "on",
    );

    const sectionBefore = await currentSection(page);
    await columns.getByRole("radio", { name: "4 columns" }).click();
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });
    // ReadiumCSS floors the target to the viewport: a requested 4 may report 3, never an automatic count.
    await expect.poll(colCountInFrame, { timeout: 30000 }).toMatch(/^[34]$/);
    await expect.poll(() => currentSection(page), { timeout: 30000 }).toBe(sectionBefore);

    await columns.getByRole("radio", { name: "One column" }).click();
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });
    await expect.poll(colCountInFrame, { timeout: 30000 }).toBe("1");
    await expect.poll(() => currentSection(page), { timeout: 30000 }).toBe(sectionBefore);

    const hostBox = await host.boundingBox();
    const containerBox = await page.locator("[data-epub-host] > div").first().boundingBox();
    expect(hostBox).not.toBeNull();
    expect(containerBox).not.toBeNull();
    if (hostBox && containerBox) {
      expect(containerBox.width).toBeLessThan(hostBox.width);
      const hostCenter = hostBox.x + hostBox.width / 2;
      const containerCenter = containerBox.x + containerBox.width / 2;
      expect(Math.abs(containerCenter - hostCenter)).toBeLessThan(2);
    }

    await page.getByTestId("pref-layout").getByText("Scrolling", { exact: true }).click();
    await expect(page.getByTestId("epub-reader")).toHaveAttribute("data-layout", "scrolling", {
      timeout: 30000,
    });
    await expect.poll(colCountInFrame, { timeout: 30000 }).toBe("");
    await expect(page.getByTestId("pref-columns")).not.toBeAttached();
    await page.getByTestId("pref-layout").getByText("Paginated", { exact: true }).click();
    await expect(page.getByTestId("epub-reader")).toHaveAttribute("data-layout", "paginated", {
      timeout: 30000,
    });
    await expect.poll(colCountInFrame, { timeout: 30000 }).toBe("1");
    await expect(
      page.getByTestId("pref-columns").getByRole("radio", { name: "One column" }),
    ).toHaveAttribute("data-state", "on");

    await page.keyboard.press("Escape");
    await page.getByTestId("appearance-content").waitFor({ state: "detached", timeout: 30000 });
    await returnToLibrary(page);
  });

  test("applies text-layout controls through the engine and across sections", async ({ page }) => {
    await openReadyEpub(page);
    const host = page.locator("div[data-epub-host]");
    await page.getByTestId("appearance-trigger").click();
    await expect(page.getByTestId("appearance-content")).toBeVisible({ timeout: 30000 });

    const frameVar = (name: string) =>
      page
        .frameLocator("[data-epub-host] iframe")
        .first()
        .locator("html")
        .evaluate((el, styleName) => el.style.getPropertyValue(styleName), name);

    const wordThumb = page.getByTestId("pref-word-spacing").getByRole("slider");
    await wordThumb.press("ArrowRight");
    await wordThumb.press("ArrowRight");
    await expect.poll(() => frameVar("--USER__wordSpacing"), { timeout: 30000 }).toBe("0.25rem");
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });
    await page.getByTestId("pref-word-spacing-reset").click();
    await expect.poll(() => frameVar("--USER__wordSpacing"), { timeout: 30000 }).toBe("");

    const letterThumb = page.getByTestId("pref-letter-spacing").getByRole("slider");
    await letterThumb.press("ArrowRight");
    await expect.poll(() => frameVar("--USER__letterSpacing"), { timeout: 30000 }).toBe("0.125rem");
    await page.keyboard.press("Escape");
    await page.getByTestId("appearance-content").waitFor({ state: "detached", timeout: 30000 });
    await page.keyboard.press("Home");
    await expect
      .poll(async () => `${await currentSection(page)}:${await engineFraction(page)}`, {
        timeout: 30000,
      })
      .toBe("0:0");
    const before = `${await currentSection(page)}:${await engineFraction(page)}`;
    await page.keyboard.press("ArrowRight");
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });
    await expect
      .poll(async () => `${await currentSection(page)}:${await engineFraction(page)}`, {
        timeout: 30000,
        message: "engine did not move",
      })
      .not.toBe(before);
    await expect.poll(() => frameVar("--USER__letterSpacing"), { timeout: 30000 }).toBe("0.125rem");

    await page.getByTestId("appearance-trigger").click();
    await expect(page.getByTestId("appearance-content")).toBeVisible({ timeout: 30000 });
    await page.getByTestId("pref-text-align").getByText("Justify", { exact: true }).click();
    await expect.poll(() => frameVar("--USER__textAlign"), { timeout: 30000 }).toBe("justify");
    await page.getByTestId("pref-text-align").getByText("Auto", { exact: true }).click();
    await expect.poll(() => frameVar("--USER__textAlign"), { timeout: 30000 }).toBe("");

    await page.getByTestId("pref-foreground-parchment").click();
    await expect.poll(() => frameVar("--USER__textColor"), { timeout: 30000 }).toBe("#f5efe0");

    // The picker must stay inside the window: native input[type=color] popups clip at the right edge.
    await page.getByTestId("pref-foreground-input").click();
    const picker = page.getByTestId("pref-foreground-picker");
    await expect(picker).toBeVisible({ timeout: 30000 });
    const pickerBox = await picker.boundingBox();
    const windowWidth = await page.evaluate(() => window.innerWidth);
    expect(pickerBox).not.toBeNull();
    if (pickerBox) {
      expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(windowWidth - 4);
    }
    await page.getByTestId("pref-foreground-hex").getByRole("textbox").fill("#336699");
    await expect.poll(() => frameVar("--USER__textColor"), { timeout: 30000 }).toBe("#336699");
    await page.keyboard.press("Escape");
    await page.getByTestId("pref-foreground-picker").waitFor({ state: "detached", timeout: 30000 });

    await page.getByTestId("pref-foreground-reset").click();
    await expect.poll(() => frameVar("--USER__textColor"), { timeout: 30000 }).toBe("");

    await page.keyboard.press("Escape");
    await page.getByTestId("appearance-content").waitFor({ state: "detached", timeout: 30000 });
    await returnToLibrary(page);
  });
  test("restores the reading position when the EPUB is reopened", async ({ page }) => {
    await openReadyEpub(page);

    await jumpToTocItem(page, 2);
    await waitForSection(page, 2);
    await page.waitForTimeout(1500);
    await returnToLibrary(page);

    await openReadyEpub(page);
    await waitForSection(page, 2);
    const percent = await textOf(page, "reader-position");
    expect(parseInt(percent, 10)).toBeGreaterThan(30);

    await returnToLibrary(page);
  });

  test("restores the exact locator across close and reopen", async ({ page }) => {
    await openReadyEpub(page);

    await jumpToTocItem(page, 1);
    await waitForSection(page, 1);
    await expect.poll(() => epubLocator(page), { timeout: 30000 }).not.toBeNull();
    const savedLocator = (await epubLocator(page)) ?? "{}";
    const saved = JSON.parse(savedLocator) as {
      href?: string;
      locations?: { progression?: number };
    };
    expect(saved.href).toContain("chapter2.xhtml");

    await page.waitForTimeout(1500);
    await returnToLibrary(page);

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

  test("finds text in the book and navigates to a match", async ({ page }) => {
    await openReadyEpub(page);

    await jumpToTocItem(page, 2);
    await waitForSection(page, 2);
    await page.getByTestId("reader-nav").waitFor({ state: "detached", timeout: 30000 });

    // Open through the toolbar button: frame focus after a drawer close is unstable here.
    await page.getByTestId("reader-search").click();
    const searchInput = page.getByTestId("reader-search-input");
    await expect(searchInput).toBeVisible({ timeout: 30000 });

    // The navigator installs a capture-phase listener on the host document: Space must stay in the field.
    await searchInput.fill("first");
    await page.keyboard.press("Space");
    await expect(searchInput).toHaveValue("first ");
    await page.keyboard.type("chapter");
    await expect(searchInput).toHaveValue("first chapter");
    await waitForSection(page, 2);

    await searchInput.fill("deterministic");

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
    expect(matchText).toContain("deterministic to open");
    const resultsText = await page.evaluate(
      () => document.querySelector("[data-testid=reader-search-results]")?.textContent ?? "",
    );
    expect(resultsText).toContain("Chapter One");

    await page.getByTestId("reader-search-match").click();
    await waitForSection(page, 0);
    await expect(page.getByTestId("reader-search-overlay")).toBeHidden({ timeout: 30000 });

    await returnToLibrary(page);
  });
});
