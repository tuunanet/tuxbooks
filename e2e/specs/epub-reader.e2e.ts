import { closeReaderNavigation, openInReader, returnToLibrary, textOf } from "./helpers.js";

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
  // the end of the document. Arrows must drive the engine's page turns.
  it("turns pages with the arrow keys through the engine", async () => {
    await openReadyEpub();
    // Position may restore from an earlier test; start from the top.
    await browser.keys("Home");
    await browser.waitUntil(
      async () => (await textOf("reader-position")) === "0%" && (await currentSection()) === "0",
      { timeout: 30000, timeoutMsg: "Home never returned to the first section" },
    );

    await browser.keys("ArrowRight");
    await browser.waitUntil(async () => /^(100|[1-9]\d*)%$/.test(await textOf("reader-position")), {
      timeout: 30000,
      timeoutMsg: "ArrowRight never changed the reading position",
    });
    const afterRight = parseInt(await textOf("reader-position"), 10);
    expect(afterRight).toBeLessThan(95);

    // A section-crossing ArrowRight schedules the fonts-settled relayout
    // 250ms after the new section mounts (WebKit quirk, see docs/epub.md);
    // a keypress inside that window is swallowed by the re-anchor. Let the
    // relayout pass before turning back.
    await browser.pause(500);

    // One ArrowLeft must go back (the old shell clamp jumped to exactly 0%,
    // so "back where we came from" is the invariant; requiring exactly 0%
    // races a double-turned ArrowRight landing one page later than expected).
    await browser.keys("ArrowLeft");
    await browser.waitUntil(
      async () => parseInt(await textOf("reader-position"), 10) < afterRight,
      { timeout: 30000, timeoutMsg: "ArrowLeft never went back" },
    );
  });

  // MathML in EPUB 3 renders natively via the browser engine; the reader
  // reports the count of <math> elements per mounted section document.
  it("renders native MathML content", async () => {
    await openReadyEpub();

    await jumpToTocItem(2);
    await waitForSection(2);

    await browser.waitUntil(
      async () => (await $("div[data-epub-host]").getAttribute("data-epub-doc-math-count")) === "1",
      { timeout: 30000, timeoutMsg: "the MathML chapter never reported its formula" },
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
