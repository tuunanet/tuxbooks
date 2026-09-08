import {
  closeReaderNavigation,
  epubLocator,
  openInReader,
  returnToLibrary,
  textOf,
} from "./helpers.js";

/** Waits until the EPUB engine reports the given spine section. */
async function waitForSection(section: number): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await browser.execute(() =>
        document
          .querySelector("[data-testid=epub-reader] [data-epub-host]")
          ?.getAttribute("data-epub-section"),
      )) === String(section),
    { timeout: 30000, timeoutMsg: `epub engine never reached section ${section}` },
  );
}

/** Current spine section reported by the engine host, or null before init. */
async function currentSection(): Promise<string | null> {
  return browser.execute(
    () =>
      document
        .querySelector("[data-testid=epub-reader] [data-epub-host]")
        ?.getAttribute("data-epub-section") ?? null,
  );
}

/** In-section progression (0..1) reported by the engine host. */
async function engineFraction(): Promise<string | null> {
  return browser.execute(
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
async function engineMovedPast(section: number, fraction: string): Promise<boolean> {
  const current = await currentSection();
  if (current === null) return false;
  const currentSectionIndex = Number(current);
  if (Number.isNaN(currentSectionIndex)) return false;
  if (currentSectionIndex !== section) return currentSectionIndex > section;
  const currentFraction = Number((await engineFraction()) ?? "0");
  return currentFraction > Number(fraction);
}

/** Opens the minimal EPUB and waits for the engine to report ready. */
async function openReadyEpub(): Promise<void> {
  await openInReader("A Minimal Book (EPUB)");
  await browser.waitUntil(async () => await $("div[data-epub-host]").isExisting(), {
    timeout: 30000,
    timeoutMsg: "epub reader never mounted its engine host",
  });
  await browser.waitUntil(
    async () => (await $("div[data-epub-host]").getAttribute("data-epub-state")) === "ready",
    { timeout: 30000, timeoutMsg: "epub engine never became ready" },
  );
}

/** Opens the contents drawer and jumps to the given TOC entry. */
async function jumpToTocItem(index: number): Promise<void> {
  await $("[data-testid=reader-nav-trigger]").click();
  await $(`[data-testid=toc-item-${index}]`).waitForDisplayed({ timeout: 30000 });
  await $(`[data-testid=toc-item-${index}]`).click();
}

describe("tuxbooks EPUB reader", () => {
  it("opens the fixture and renders it through the engine", async () => {
    await openReadyEpub();
    // The shell footer tracks the engine's progression (starts at the top).
    await browser.waitUntil(async () => /^(100|[1-9]?\d)%$/.test(await textOf("reader-position")), {
      timeout: 30000,
      timeoutMsg: "reader position never reported a percentage",
    });
    await returnToLibrary();
  });

  it("navigates chapters from the contents drawer", async () => {
    await openReadyEpub();
    expect(await currentSection()).toBe("0");

    await jumpToTocItem(2);
    await waitForSection(2);
    await $("[data-testid=reader-nav]").waitForDisplayed({ reverse: true, timeout: 30000 });

    await returnToLibrary();
  });

  // Regression: the shell used to keep its percentage-stepping arrow
  // handlers registered for EPUB, where the step is 100/0 (no page count)
  // and the provider clamps straight to 100%/0% — one ArrowRight landed on
  // the end of the document. Arrows must drive the engine's page turns:
  // asserted on the engine's pinned fraction/section attributes (exact
  // engine truth) rather than the interpolated shell percent.
  it("turns pages with the arrow keys through the engine", async () => {
    await openReadyEpub();
    // Position may restore from an earlier test; start from the top.
    await browser.keys("Home");
    await browser.waitUntil(
      async () =>
        (await currentSection()) === "0" &&
        (await engineFraction()) === "0" &&
        (await textOf("reader-position")) === "0%",
      { timeout: 30000, timeoutMsg: "Home never returned to the first section" },
    );

    await browser.keys("ArrowRight");
    await browser.waitUntil(async () => await engineMovedPast(0, "0"), {
      timeout: 30000,
      timeoutMsg: "ArrowRight never changed the reading position",
    });
    const afterRight = {
      section: await currentSection(),
      fraction: await engineFraction(),
    };
    expect(parseInt(await textOf("reader-position"), 10)).toBeLessThan(95);

    // One ArrowLeft must go back: the engine fraction/section must not sit
    // past where ArrowRight landed.
    await browser.keys("ArrowLeft");
    await browser.waitUntil(
      async () => !(await engineMovedPast(afterRight.section, afterRight.fraction ?? "0")),
      { timeout: 30000, timeoutMsg: "ArrowLeft never went back" },
    );
  });

  // MathML in EPUB 3 renders natively via the browser engine; the fixture's
  // third chapter carries one formula.
  it("renders native MathML content", async () => {
    await openReadyEpub();

    await jumpToTocItem(2);
    await waitForSection(2);

    await browser.waitUntil(
      async () =>
        (await browser.execute(() => {
          const host = document.querySelector("[data-epub-host]");
          for (const frame of host?.querySelectorAll("iframe") ?? []) {
            try {
              if ((frame.contentDocument?.querySelectorAll("math").length ?? 0) > 0) return true;
            } catch {
              continue;
            }
          }
          return false;
        })) === true,
      { timeout: 30000, timeoutMsg: "the MathML chapter never rendered its formula" },
    );

    await returnToLibrary();
  });

  it("applies appearance preferences to the reading surface", async () => {
    await openReadyEpub();

    await $("[data-testid=appearance-trigger]").click();
    await $("[data-testid=appearance-content]").waitForDisplayed({ timeout: 30000 });
    await $("button=Serif").click();
    await $("button=Paper").click();
    await $("button=Scrolling").click();
    await browser.waitUntil(
      async () => (await $("[data-testid=reader-view]").getAttribute("data-theme")) === "paper",
      { timeout: 30000, timeoutMsg: "paper theme never applied to the reader shell" },
    );
    await browser.waitUntil(
      async () =>
        (await $("[data-testid=epub-reader]").getAttribute("data-layout")) === "scrolling",
      { timeout: 30000, timeoutMsg: "scrolling layout never applied" },
    );

    // Close the popover so it cannot intercept the toolbar clicks below.
    await browser.keys("Escape");
    await $("[data-testid=appearance-content]").waitForDisplayed({
      reverse: true,
      timeout: 30000,
    });

    await returnToLibrary();
  });

  // Critical acceptance test (§ persistence): the reader resumes the saved
  // CFI location after the book is closed and reopened.
  it("restores the reading position when the EPUB is reopened", async () => {
    await openReadyEpub();

    // Jump to Chapter Three via the contents drawer and let the debounced
    // save land before leaving the reader.
    await jumpToTocItem(2);
    await waitForSection(2);
    await browser.pause(1500);
    await returnToLibrary();

    // Reopen: the engine restores into Chapter Three (spine section 2).
    await openReadyEpub();
    await waitForSection(2);
    const percent = await textOf("reader-position");
    expect(parseInt(percent, 10)).toBeGreaterThan(30);

    await returnToLibrary();
  });

  // Semantic persistence regression (docs/testing.md): the exact engine
  // locator — not just the section index or a percentage — survives the
  // close/reopen cycle. This is the reading-position regression protection
  // the engine migration (foliate → Readium) must keep passing. The locator
  // grammar is the serialized Readium locator JSON; the restored locator
  // must name the same section at the same in-section progression.
  it("restores the exact locator across close and reopen", async () => {
    await openReadyEpub();

    // Land on a known in-chapter position via the contents drawer.
    await jumpToTocItem(1);
    await waitForSection(1);
    await browser.waitUntil(async () => (await epubLocator()) !== null, {
      timeout: 30000,
      timeoutMsg: "engine never reported its locator",
    });
    const savedLocator = await epubLocator();
    const saved = JSON.parse(savedLocator ?? "{}") as {
      href?: string;
      locations?: { progression?: number };
    };
    expect(saved.href).toContain("chapter2.xhtml");

    // Let the debounced save flush before leaving the reader.
    await browser.pause(1500);
    await returnToLibrary();

    // Reopen: the restored locator names the same logical content position
    // (same section, same in-section progression within a tolerance).
    await openReadyEpub();
    await browser.waitUntil(async () => (await epubLocator()) !== null, {
      timeout: 30000,
      timeoutMsg: "reopened engine never reported its locator",
    });
    const restoredLocator = await epubLocator();
    const restored = JSON.parse(restoredLocator ?? "{}") as {
      href?: string;
      locations?: { progression?: number };
    };
    expect(restored.href).toBe(saved.href);
    const savedProgression = saved.locations?.progression ?? 0;
    const restoredProgression = restored.locations?.progression ?? 0;
    expect(Math.abs(restoredProgression - savedProgression)).toBeLessThan(0.1);
    await waitForSection(1);

    await returnToLibrary();
  });

  // Milestone 5 — in-book search: the drawer's Search tab streams matches
  // from the engine (query, count, excerpt, chapter) and navigating to a
  // match moves the engine to the match's CFI.
  it("finds text in the book and navigates to a match", async () => {
    await openReadyEpub();

    // Move away from Chapter One so navigating to the match is observable.
    await jumpToTocItem(2);
    await waitForSection(2);
    await $("[data-testid=reader-nav]").waitForDisplayed({ reverse: true, timeout: 30000 });

    await $("[data-testid=reader-search]").click();
    await $("[data-testid=reader-search-input]").waitForDisplayed({ timeout: 30000 });
    await $("[data-testid=reader-search-input]").setValue("deterministic");

    // "deterministic" occurs exactly once, in Chapter One's text.
    await browser.waitUntil(
      async () => (await $$("[data-testid=reader-search-match]")).length > 0,
      { timeout: 30000, timeoutMsg: "in-book search never produced results" },
    );
    await browser.waitUntil(
      async () => (await textOf("reader-search-status")).includes("1 match"),
      { timeout: 30000, timeoutMsg: "search status never reported the match count" },
    );
    const matchText = await browser.execute(
      () => document.querySelector("[data-testid=reader-search-match]")?.textContent ?? "",
    );
    expect(matchText).toContain("deterministic");
    const resultsText = await browser.execute(
      () => document.querySelector("[data-testid=reader-search-results]")?.textContent ?? "",
    );
    expect(resultsText).toContain("Chapter One");

    // Clicking the match drives the engine back to Chapter One (section 0);
    // the drawer stays open so the next hit is one click away.
    await $("[data-testid=reader-search-match]").click();
    await waitForSection(0);
    await expect($("[data-testid=reader-nav]")).toBeDisplayed();

    await closeReaderNavigation();
    await returnToLibrary();
  });
});
