describe("tuxbooks library navigation", () => {
  // WebKitGTK's WebDriver getText walks the accessibility tree, which omits
  // text inside line-clamp/truncate boxes (book titles, reader title). Where
  // those classes apply, assert on DOM textContent instead of toHaveText.

  async function textOf(testId: string): Promise<string> {
    return browser.execute((id) => {
      const element = document.querySelector(`[data-testid=${JSON.stringify(id)}]`);
      return element ? (element.textContent ?? "") : "";
    }, testId);
  }

  async function waitForLibraryView(): Promise<void> {
    // Re-query on every poll: a reference captured during startup can go
    // stale on WebKit when the library mounts, and isDisplayed would then
    // report false forever even though the view is on screen.
    await browser.waitUntil(
      async () => {
        const view = await $("[data-testid=library-view]");
        return (await view.isExisting()) && (await view.isDisplayed());
      },
      { timeout: 30000, timeoutMsg: "library view never became visible" },
    );
  }

  /** Book cards expose `aria-label="{title} ({FORMAT})"` — open by name. */
  async function openBookFromLibrary(ariaLabel: string): Promise<void> {
    await waitForLibraryView();
    const card = await $(`[aria-label="${ariaLabel}"]`);
    await card.waitForDisplayed({ timeout: 30000 });
    await card.doubleClick();
  }

  // Test B — the library shows both fixture formats with the sidebar up.
  it("shows All Books with the fixture EPUB and the fixture PDF", async () => {
    await waitForLibraryView();

    await expect($('[aria-label="Library sidebar"]')).toBeDisplayed();
    await expect($("button=All Books")).toBeDisplayed();

    const cards = await $$("[data-testid=book-card]");
    expect(cards.length).toBe(2);

    const cardTexts = await browser.execute(() => {
      return Array.from(document.querySelectorAll<HTMLElement>("[data-testid=book-card]")).map(
        (card) => card.textContent ?? "",
      );
    });
    const allText = cardTexts.join("\n");
    expect(allText).toContain("A Minimal Book");
    expect(allText).toContain("A Minimal Manual");

    await expect(await textOf("library-stats")).toContain("2 books");
  });

  // Test C — detail view with title and format for the EPUB fixture.
  it("opens the EPUB detail view showing title and format", async () => {
    await openBookFromLibrary("A Minimal Book (EPUB)");

    await $("[data-testid=book-detail]").waitForDisplayed({ timeout: 30000 });
    await expect(await textOf("detail-title")).toContain("A Minimal Book");
    await expect(await textOf("detail-facts")).toContain("EPUB");

    await $("[data-testid=detail-back]").click();
    await waitForLibraryView();
  });

  // Test D — the PDF fixture opens the reader shell: toolbar visible,
  // library sidebar gone, and the real PDF.js canvas rendered.
  it("opens the PDF in the reader shell with the sidebar hidden", async () => {
    await openBookFromLibrary("A Minimal Manual (PDF)");

    await $("[data-testid=book-detail]").waitForDisplayed({ timeout: 30000 });
    await $("[data-testid=detail-continue]").click();

    await $("[data-testid=reader-view]").waitForDisplayed({ timeout: 30000 });
    await expect(await textOf("reader-title")).toContain("A Minimal Manual");
    await $("[data-testid=pdf-canvas]").waitForExist({ timeout: 30000 });
    await expect($("[data-testid=reader-back]")).toBeDisplayed();
    await expect($("[data-testid=sidebar]")).not.toExist();

    await $("[data-testid=reader-back]").click();
    await expect($("[data-testid=app-shell]")).toBeDisplayed();
    await expect($('[aria-label="Library sidebar"]')).toBeDisplayed();
  });

  // Test E — the PDF rendering slice: page 1 of the fixture is drawn onto the
  // canvas, prev/next navigate pages, zoom re-renders at a new scale.
  it("renders PDF pages with navigation and zoom", async () => {
    await openBookFromLibrary("A Minimal Manual (PDF)");

    await $("[data-testid=book-detail]").waitForDisplayed({ timeout: 30000 });
    await $("[data-testid=detail-continue]").click();
    await $("[data-testid=reader-view]").waitForDisplayed({ timeout: 30000 });

    const canvas = await $("[data-testid=pdf-canvas]");
    await canvas.waitForExist({ timeout: 30000 });

    // The real page count arrives with the loaded document.
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 1 of 3", {
      timeout: 30000,
      timeoutMsg: "pdf document never reported its page count",
    });

    // Deterministic geometry: fixture pages are 612x792 pt, so at 100% zoom
    // the canvas backing store is 612 px wide times the device pixel ratio.
    const dpr = await browser.execute(() => window.devicePixelRatio);
    await browser.waitUntil(
      async () => Number(await canvas.getAttribute("width")) === Math.floor(612 * dpr),
      { timeout: 30000, timeoutMsg: "page 1 never rendered at 100% zoom" },
    );

    // The canvas carries fixture artwork: a blank canvas has no non-white
    // pixels, the drawn page (blue rectangle + black text) does.
    const nonBlank = await browser.execute(() => {
      const el = document.querySelector("[data-testid=pdf-canvas]");
      if (!(el instanceof HTMLCanvasElement)) return false;
      const ctx = el.getContext("2d");
      if (!ctx) return false;
      const { data } = ctx.getImageData(0, 0, el.width, el.height);
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) return true;
      }
      return false;
    });
    expect(nonBlank).toBe(true);

    // Navigation moves between pages and back.
    await $("[data-testid=pdf-next]").click();
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 2 of 3", {
      timeout: 30000,
      timeoutMsg: "next never reached page 2",
    });
    await $("[data-testid=pdf-prev]").click();
    await browser.waitUntil(async () => (await textOf("pdf-page-indicator")) === "Page 1 of 3", {
      timeout: 30000,
      timeoutMsg: "prev never returned to page 1",
    });

    // Zoom in: 100% -> 150% re-renders with a larger backing store.
    await $("[data-testid=pdf-zoom-in]").click();
    await browser.waitUntil(
      async () => Number(await canvas.getAttribute("width")) === Math.floor(612 * 1.5 * dpr),
      { timeout: 30000, timeoutMsg: "zoom-in never re-rendered at 150%" },
    );
    expect(await textOf("pdf-zoom-level")).toContain("150%");

    await $("[data-testid=reader-back]").click();
    await expect($("[data-testid=app-shell]")).toBeDisplayed();
  });
});
