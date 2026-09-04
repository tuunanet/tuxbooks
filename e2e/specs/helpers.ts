/**
 * Shared helpers for the seeded-library spec files. WebKitGTK's WebDriver
 * getText walks the accessibility tree, which omits text inside
 * line-clamp/truncate boxes (book titles, reader title) — where those apply,
 * assert on DOM textContent (`textOf`) instead of toHaveText.
 */

export async function textOf(testId: string): Promise<string> {
  return browser.execute((id) => {
    const element = document.querySelector(`[data-testid=${JSON.stringify(id)}]`);
    return element ? (element.textContent ?? "") : "";
  }, testId);
}

export async function waitForLibraryView(): Promise<void> {
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

/**
 * Leave the reader if one is open, then wait for the library. Reader tests
 * are order-independent: a previous test may have left the reader open.
 */
export async function ensureLibrary(): Promise<void> {
  const reader = await $("[data-testid=reader-view]");
  if (await reader.isExisting()) {
    await $("[data-testid=reader-back]").click();
  }
  await waitForLibraryView();
}

/** Book cards expose `aria-label="{title} ({FORMAT})"` — open by name. */
export async function openBookDetail(ariaLabel: string): Promise<void> {
  await ensureLibrary();
  const card = await $(`[aria-label="${ariaLabel}"]`);
  await card.waitForDisplayed({ timeout: 30000 });
  await card.doubleClick();
  await $("[data-testid=book-detail]").waitForDisplayed({ timeout: 30000 });
}

/**
 * Click that re-queries the selector when WebKitWebDriver reports a stale
 * element: the reader re-renders while page renders stream in, and under
 * load an element handle can go stale between resolution and the click
 * protocol call. Everything else about the click is unchanged.
 */
export async function clickRetryingStale(selector: string, attempts = 5): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await (await $(selector)).click();
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/stale/i.test(message) || attempt >= attempts - 1) throw err;
    }
  }
}

/**
 * Clicks and waits for an observable effect, retrying the click when it
 * never took effect: under load WebKitGTK can swallow a click into a
 * fading sheet overlay (the contents drawer's exit animation outlives the
 * drawer element's removal). `condition` polls reader-visible state, so a
 * click that worked but has not converged yet is never re-fired early.
 */
export async function clickUntilEffect(
  selector: string,
  condition: () => Promise<boolean>,
  attempts = 3,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await clickRetryingStale(selector);
    const settled = await browser
      .waitUntil(condition, { timeout: 8000, timeoutMsg: "unused" })
      .then(() => true)
      .catch(() => false);
    if (settled) return;
  }
  throw new Error(`click on ${selector} never produced its expected effect`);
}

/**
 * Opens the contents drawer from the reader header, retrying when the
 * opening click was swallowed by a closing drawer's fade-out.
 */
export async function openReaderNavigation(): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await $("[data-testid=reader-nav-trigger]").click();
    const opened = await $("[data-testid=reader-nav]")
      .waitForExist({ timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (opened) return;
  }
  throw new Error("reader navigation drawer never opened");
}

/** Open a book's detail view and continue into the reader. */
export async function openInReader(ariaLabel: string): Promise<void> {
  await openBookDetail(ariaLabel);
  await $("[data-testid=detail-continue]").click();
  await $("[data-testid=reader-view]").waitForDisplayed({ timeout: 30000 });
}

/** Close the reader and wait for the library. */
export async function returnToLibrary(): Promise<void> {
  await $("[data-testid=reader-back]").click();
  await expect($("[data-testid=app-shell]")).toBeDisplayed();
  await waitForLibraryView();
}

/** DOM attributes of every PDF slot, in document order. */
export async function slotStates(): Promise<{ page: string; state: string }[]> {
  return browser.execute(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-pdf-slot]")).map((slot) => ({
      page: slot.getAttribute("data-pdf-slot") ?? "",
      state: slot.getAttribute("data-render-state") ?? "",
    })),
  );
}

export async function renderedCount(): Promise<number> {
  return browser.execute(() => document.querySelectorAll('[data-render-state="rendered"]').length);
}

export async function waitForRendered(pageNumber: number, timeoutMs = 30000): Promise<void> {
  await browser.waitUntil(
    async () => {
      const state = await browser.execute(
        (page) =>
          document.querySelector(`[data-pdf-slot="${page}"]`)?.getAttribute("data-render-state"),
        pageNumber,
      );
      return state === "rendered";
    },
    { timeout: timeoutMs, timeoutMsg: `page ${pageNumber} never rendered` },
  );
}

/**
 * Scroll the reader's scroll container so slot `pageNumber` sits near the
 * top of the viewport. Offsets are derived from live element geometry, not
 * hard-coded pixels.
 */
export async function scrollToSlot(pageNumber: number): Promise<void> {
  await browser.execute((page) => {
    const container = document.querySelector<HTMLElement>("[data-testid=reader-content]");
    const slot = document.querySelector(`[data-pdf-slot="${page}"]`);
    if (!container || !slot) return;
    const target =
      slot.getBoundingClientRect().top +
      container.scrollTop -
      container.getBoundingClientRect().top -
      80;
    container.scrollTop = target;
  }, pageNumber);
}

/**
 * Fit-width factor: the reader fits the 612pt reference page into the
 * content area, so rendered geometry scales by clientWidth/612.
 */
export async function fitFactor(): Promise<number> {
  return browser.execute(
    () => (document.querySelector("[data-testid=pdf-content-area]")?.clientWidth ?? 0) / 612,
  );
}

/**
 * Upper bound on one retained page bitmap: the 612×792pt reference page at
 * `zoomMultiplier` × fit-width, at the device pixel ratio (mirrors
 * PdfPageCanvas's buffer sizing; ceil keeps it a safe upper bound). The
 * bitmap cache may hold exactly one entry beyond its byte budget — the
 * newest, oversized-keep-latest.
 */
export async function maxSingleBitmapBytes(zoomMultiplier: number): Promise<number> {
  const dpr = await browser.execute(() => window.devicePixelRatio);
  const fit = await fitFactor();
  const width = Math.ceil(612 * fit * zoomMultiplier * dpr);
  const height = Math.ceil(792 * fit * zoomMultiplier * dpr);
  return width * height * 4;
}

/** Canvas-pixel probe shared by rendering assertions (mirrors books.e2e). */
export async function canvasIsNonBlank(
  pageNumber: number,
  testId = "pdf-canvas",
): Promise<boolean> {
  return browser.execute(
    (page, id) => {
      const el = document.querySelector(
        `[data-testid=${JSON.stringify(id)}][data-pdf-page="${page}"]`,
      );
      if (!(el instanceof HTMLCanvasElement)) return false;
      const ctx = el.getContext("2d");
      if (!ctx) return false;
      const { data } = ctx.getImageData(0, 0, el.width, el.height);
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) return true;
      }
      return false;
    },
    pageNumber,
    testId,
  );
}

/** Thumbnail cells are always mounted; canvases only inside the render set. */
export async function thumbnailState(pageNumber: number): Promise<string> {
  return browser.execute(
    (page) =>
      document.querySelector(`[data-pdf-thumb-slot="${page}"]`)?.getAttribute("data-thumb-state") ??
      "",
    pageNumber,
  );
}

export async function thumbnailCanvasCount(): Promise<number> {
  return browser.execute(() => document.querySelectorAll('[data-testid="pdf-thumbnail"]').length);
}

/** True when the sidebar names this page as the reading position. */
export async function thumbnailIsActive(pageNumber: number): Promise<boolean> {
  return browser.execute(
    (page) =>
      document
        .querySelector(`[data-pdf-thumb-slot="${page}"]`)
        ?.hasAttribute("data-thumb-active") ?? false,
    pageNumber,
  );
}

/** Scrolls the thumbnails sidebar list so deep pages approach the viewport. */
export async function scrollThumbnailsToBottom(): Promise<void> {
  await browser.execute(() => {
    const list = document.querySelector<HTMLElement>('[data-testid="pdf-thumbnails-scroll"]');
    if (list) list.scrollTop = list.scrollHeight;
  });
}

/**
 * Reader bitmap-cache occupancy, parsed from the `data-pdf-bitmap-cache`
 * diagnostics attribute (`entries:bytes`), or null while no reader surface
 * is mounted.
 */
export async function bitmapCacheUsage(): Promise<{ entries: number; bytes: number } | null> {
  const raw = await browser.execute(
    () =>
      document.querySelector("[data-testid=pdf-reader]")?.getAttribute("data-pdf-bitmap-cache") ??
      null,
  );
  if (!raw) return null;
  const [entries, bytes] = raw.split(":").map(Number);
  return { entries: entries ?? 0, bytes: bytes ?? 0 };
}

export interface PdfSurfaceMemory {
  pageCanvases: number;
  pageBytes: number;
  thumbnailCanvases: number;
  thumbnailBytes: number;
}

/**
 * Approximate live canvas memory of the PDF reader (main pages and
 * thumbnails): canvas count plus RGBA bytes of the backing stores. This is
 * the measurable part of "PDF canvas memory / thumbnail memory" — the
 * bitmap cache on top of it is bounded separately (`bitmapCacheUsage`).
 */
export async function pdfSurfaceMemory(): Promise<PdfSurfaceMemory> {
  return browser.execute(() => {
    // No function declarations or const-bound arrows in here: the callback
    // is serialized to the browser verbatim, and transpiler name-retention
    // helpers (`__name`) do not travel with it.
    const pageCanvases = document.querySelectorAll<HTMLCanvasElement>('[data-testid="pdf-canvas"]');
    const thumbnailCanvases = document.querySelectorAll<HTMLCanvasElement>(
      '[data-testid="pdf-thumbnail"]',
    );
    let pageBytes = 0;
    for (const canvas of Array.from(pageCanvases)) pageBytes += canvas.width * canvas.height * 4;
    let thumbnailBytes = 0;
    for (const canvas of Array.from(thumbnailCanvases)) {
      thumbnailBytes += canvas.width * canvas.height * 4;
    }
    return {
      pageCanvases: pageCanvases.length,
      pageBytes,
      thumbnailCanvases: thumbnailCanvases.length,
      thumbnailBytes,
    };
  });
}

/** Number of EPUB engine hosts connected to the document (≤ 1 expected). */
export async function epubHostCount(): Promise<number> {
  return browser.execute(() => document.querySelectorAll("[data-epub-host]").length);
}

/** The reading page reported by the PDF page indicator, or null. */
export async function currentPageNumber(): Promise<number | null> {
  const text = await textOf("pdf-page-indicator");
  return Number(text.match(/Page (\d+) of/)?.[1]) || null;
}
