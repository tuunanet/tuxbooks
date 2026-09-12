/**
 * Shared helpers for the seeded-library spec files, ported to Playwright.
 * Selector strategy is unchanged: stable application-facing hooks
 * (`data-testid`, `aria-label`, documented reader-state attributes from
 * docs/EPUB.md + docs/PDF.md) — no private implementation reach-ins.
 */
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * First mounted page canvas, in document order. The render set can hold
 * several canvases at once (bounded virtualization) — the original
 * harness's `$` resolved the first match, and the fit-width/zoom geometry
 * assertions target that same first page.
 */
export function firstPdfCanvas(page: Page): Locator {
  return page.locator("[data-testid=pdf-canvas]").first();
}

/** DOM text of a test id ("" when absent) — titles live in line-clamp boxes. */
export async function textOf(page: Page, testId: string): Promise<string> {
  const element = page.getByTestId(testId);
  if ((await element.count()) === 0) return "";
  return (await element.first().textContent()) ?? "";
}

export async function waitForLibraryView(page: Page): Promise<void> {
  await expect(page.getByTestId("library-view")).toBeVisible({ timeout: 30000 });
}

/**
 * Leave the reader if one is open, then wait for the library. Reader tests
 * are order-independent: a previous test may have left the reader open.
 */
export async function ensureLibrary(page: Page): Promise<void> {
  if ((await page.getByTestId("reader-view").count()) > 0) {
    await page.getByTestId("reader-back").click();
  }
  await waitForLibraryView(page);
}

/** Book cards expose `aria-label="{title} ({FORMAT})"` — open by name. */
export async function openBookDetail(page: Page, ariaLabel: string): Promise<void> {
  await ensureLibrary(page);
  const card = page.locator(`[aria-label="${ariaLabel}"]`);
  await card.waitFor({ state: "visible", timeout: 30000 });
  await card.dblclick();
  await expect(page.getByTestId("book-detail")).toBeVisible({ timeout: 30000 });
}

/**
 * Clicks and waits for an observable effect, retrying the click when it
 * never took effect (an overlay's exit animation can swallow a click).
 * `condition` polls reader-visible state, so a click that worked but has
 * not converged yet is never re-fired early.
 */
export async function clickUntilEffect(
  page: Page,
  selector: string,
  condition: () => Promise<boolean>,
  attempts = 3,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await page.locator(selector).click();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await page.waitForTimeout(250);
    }
  }
  throw new Error(`click on ${selector} never produced its expected effect`);
}

/**
 * Opens the contents drawer from the reader header, retrying when the
 * opening click was swallowed by a closing drawer's fade-out.
 */
export async function openReaderNavigation(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.getByTestId("reader-nav-trigger").click();
    const opened = await page
      .getByTestId("reader-nav")
      .waitFor({ state: "visible", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (opened) return;
  }
  throw new Error("reader navigation drawer never opened");
}

/**
 * Opens a drawer tab and waits for its content, retrying when the drawer's
 * mount animation detaches the tab (or the opening click lands mid-flight).
 * `contentTestId` is any element only visible while the tab is the active
 * panel (a row, or the tab's empty state).
 */
export async function openReaderTab(
  page: Page,
  tabTestId: string,
  contentTestId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await page.getByTestId("reader-nav").count()) === 0) {
      await openReaderNavigation(page);
    }
    await page
      .getByTestId(tabTestId)
      .click({ timeout: 5000 })
      .catch(() => {});
    const shown = await page
      .getByTestId(contentTestId)
      .waitFor({ state: "visible", timeout: 2000 })
      .then(() => true)
      .catch(() => false);
    if (shown) return;
  }
  throw new Error(`drawer tab ${tabTestId} never showed ${contentTestId}`);
}

/**
 * Closes the navigation drawer when a test intentionally left it open
 * (in-book search keeps it open so the next match is one click away).
 * The open drawer's overlay would otherwise block the reader toolbar.
 */
export async function closeReaderNavigation(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const drawer = page.getByTestId("reader-nav");
    if ((await drawer.count()) === 0) return;
    await drawer.locator("[data-slot=sheet-close]").click();
    const closed = await drawer
      .waitFor({ state: "detached", timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (closed) return;
  }
  throw new Error("reader navigation drawer never closed");
}

/** Open a book's detail view and continue into the reader. */
export async function openInReader(page: Page, ariaLabel: string): Promise<void> {
  await openBookDetail(page, ariaLabel);
  await page.getByTestId("detail-continue").click();
  await expect(page.getByTestId("reader-view")).toBeVisible({ timeout: 30000 });
}

/** Close the reader and wait for the library. */
export async function returnToLibrary(page: Page): Promise<void> {
  await page.getByTestId("reader-back").click();
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await waitForLibraryView(page);
}

/** DOM attributes of every PDF slot, in document order. */
export async function slotStates(page: Page): Promise<{ page: string; state: string }[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>("[data-pdf-slot]")).map((slot) => ({
      page: slot.getAttribute("data-pdf-slot") ?? "",
      state: slot.getAttribute("data-render-state") ?? "",
    })),
  );
}

export async function renderedCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-render-state="rendered"]').length);
}

export async function waitForRendered(
  page: Page,
  pageNumber: number,
  timeoutMs = 30000,
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (target) =>
            document
              .querySelector(`[data-pdf-slot="${target}"]`)
              ?.getAttribute("data-render-state"),
          pageNumber,
        ),
      { timeout: timeoutMs, message: `page ${pageNumber} never rendered` },
    )
    .toBe("rendered");
}

/**
 * Scroll the reader's scroll container so slot `pageNumber` sits near the
 * top of the viewport. Offsets are derived from live element geometry, not
 * hard-coded pixels.
 */
export async function scrollToSlot(page: Page, pageNumber: number): Promise<void> {
  await page.evaluate((target) => {
    const container = document.querySelector<HTMLElement>("[data-testid=reader-content]");
    const slot = document.querySelector(`[data-pdf-slot="${target}"]`);
    if (!container || !slot) return;
    const rect =
      slot.getBoundingClientRect().top +
      container.scrollTop -
      container.getBoundingClientRect().top -
      80;
    container.scrollTop = rect;
  }, pageNumber);
}

/**
 * Fit-width factor: the reader fits the 612pt reference page into the
 * content area, so rendered geometry scales by clientWidth/612.
 */
export async function fitFactor(page: Page): Promise<number> {
  return page.evaluate(
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
export async function maxSingleBitmapBytes(page: Page, zoomMultiplier: number): Promise<number> {
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  const fit = await fitFactor(page);
  const width = Math.ceil(612 * fit * zoomMultiplier * dpr);
  const height = Math.ceil(792 * fit * zoomMultiplier * dpr);
  return width * height * 4;
}

/** Canvas-pixel probe shared by rendering assertions (mirrors books spec). */
export async function canvasIsNonBlank(
  page: Page,
  pageNumber: number,
  testId = "pdf-canvas",
): Promise<boolean> {
  return page.evaluate(
    ([target, id]) => {
      const el = document.querySelector(
        `[data-testid=${JSON.stringify(id)}][data-pdf-page="${target}"]`,
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
    [pageNumber, testId] as const,
  );
}

/** Thumbnail cells are always mounted; canvases only inside the render set. */
export async function thumbnailState(page: Page, pageNumber: number): Promise<string> {
  return page.evaluate(
    (target) =>
      document
        .querySelector(`[data-pdf-thumb-slot="${target}"]`)
        ?.getAttribute("data-thumb-state") ?? "",
    pageNumber,
  );
}

export async function thumbnailCanvasCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-testid="pdf-thumbnail"]').length);
}

/** True when the sidebar names this page as the reading position. */
export async function thumbnailIsActive(page: Page, pageNumber: number): Promise<boolean> {
  return page.evaluate(
    (target) =>
      document
        .querySelector(`[data-pdf-thumb-slot="${target}"]`)
        ?.hasAttribute("data-thumb-active") ?? false,
    pageNumber,
  );
}

/** Scrolls the thumbnails sidebar list so deep pages approach the viewport. */
export async function scrollThumbnailsToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-testid="pdf-thumbnails-scroll"]');
    if (list) list.scrollTop = list.scrollHeight;
  });
}

/**
 * Reader bitmap-cache occupancy, parsed from the `data-pdf-bitmap-cache`
 * diagnostics attribute (`entries:bytes`), or null while no reader surface
 * is mounted.
 */
export async function bitmapCacheUsage(
  page: Page,
): Promise<{ entries: number; bytes: number } | null> {
  const raw = await page.evaluate(
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
export async function pdfSurfaceMemory(page: Page): Promise<PdfSurfaceMemory> {
  return page.evaluate(() => {
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
export async function epubHostCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll("[data-epub-host]").length);
}

/**
 * The engine host's stable attributes (docs/EPUB.md). The CFI locator is
 * what the persistence layer would save right now — the semantic location
 * probe for the round-trip and migration tests.
 */
export async function epubLocator(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document
        .querySelector("[data-testid=epub-reader] [data-epub-host]")
        ?.getAttribute("data-epub-locator") ?? null,
  );
}

/** Spine section count reported by the engine host, or null before init. */
export async function epubSectionTotal(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document
        .querySelector("[data-testid=epub-reader] [data-epub-host]")
        ?.getAttribute("data-epub-section-total") ?? null,
  );
}

/**
 * The PDF reader's engine lifecycle attribute (docs/PDF.md): one of
 * document-loading | document-parsed | layout-ready | interactive | error.
 * Failure modes name their stage instead of leaving the tests to infer from
 * a missing reader surface.
 */
export async function pdfEngineState(page: Page): Promise<string | null> {
  return page.evaluate(
    () =>
      document.querySelector("[data-testid=pdf-reader]")?.getAttribute("data-pdf-engine-state") ??
      null,
  );
}

/** Waits until the PDF engine reaches the given lifecycle stage. */
export async function waitForPdfEngineState(
  page: Page,
  stage: string,
  timeoutMs = 30000,
): Promise<void> {
  await expect
    .poll(() => pdfEngineState(page), {
      timeout: timeoutMs,
      message: `pdf engine never reached state "${stage}"`,
    })
    .toBe(stage);
}

/** The reading page reported by the PDF page indicator, or null. */
export async function currentPageNumber(page: Page): Promise<number | null> {
  const text = await textOf(page, "pdf-page-indicator");
  return Number(text.match(/Page (\d+) of/)?.[1]) || null;
}
