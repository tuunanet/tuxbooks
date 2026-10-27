/**
 * Book-mode journeys (tuxbooks-9pr.8, spec tuxbooks-9pr → E2E): the full
 * PDF reader journey over the minimal fixture — cover alone, facing
 * spread, keyboard turn, restore across reopen, and the scroll view
 * unchanged off — plus the EPUB spread change, instant with no turn
 * phase at all, reduced motion or not (ADR 0011). Both also assert the
 * assistive-technology contract: the book container is a named region
 * and the next/previous-spread actions are labelled buttons in the
 * accessibility tree.
 */
import { expect, test, type Page } from "../fixtures/electron-app.js";
import {
  BOOK_SPREAD_LABEL,
  BOOK_TURN_LABELS,
} from "../../frontend/src/components/reader/bookModeLabels.js";

import {
  canvasIsNonBlank,
  epubLocator,
  firstPdfCanvas,
  openInReader,
  openReaderNavigation,
  returnToLibrary,
  waitForPdfBookRendered,
  waitForPdfEngineState,
  waitForRendered,
} from "./helpers.js";

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

/**
 * Turn-phase attributes anywhere on the page. The instant turn publishes
 * none, at any point — this counts them so a lingering or mid-turn
 * phase fails the journey (ADR 0011).
 */
async function turnPhaseAttributes(page: Page): Promise<number> {
  return page.evaluate(
    () => document.querySelectorAll("[data-epub-turn-phase], [data-epub-turn-direction]").length,
  );
}

test.describe("tuxbooks book mode", () => {
  test("reads a PDF as a book: cover alone, facing spread, keyboard turn, restore, scroll view off", async ({
    page,
  }) => {
    await openInReader(page, "A Minimal Manual (PDF)");
    await waitForPdfEngineState(page, "interactive");

    // Known start: the scroll view's first page, before book mode mounts.
    await page.keyboard.press("Home");
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });

    // Book mode on through the toolbar control (aria-pressed mirrors the
    // persisted flag; the fixture cleared it per test, so it starts off).
    const toggle = page.getByTestId("reader-book-mode");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: 30000 });
    await expect(page.getByTestId("pdf-book-view")).toBeVisible({ timeout: 30000 });

    // The cover stands alone: one painted page, and the assistive-tech
    // contract — a named book region with the labelled spread actions.
    await waitForPdfBookRendered(page, [1]);
    await expect(page.locator("[data-pdf-book-page]")).toHaveCount(1);
    await expect(page.getByRole("region", { name: BOOK_SPREAD_LABEL })).toBeVisible();
    await expect(page.getByRole("button", { name: BOOK_TURN_LABELS.next }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: BOOK_TURN_LABELS.prev }).first()).toBeVisible();

    // Stage 1 is fit-the-pair only: the toolbar's zoom controls act on
    // scroll-view-only state, so they are gone while book mode is on —
    // and back after the toggle-off below.
    await expect(page.getByTestId("pdf-zoom-in")).toHaveCount(0);
    await expect(page.getByTestId("pdf-zoom-out")).toHaveCount(0);
    await expect(page.getByTestId("pdf-zoom-input")).toHaveCount(0);

    // Advancing through the labelled next action turns one spread: the
    // facing pair replaces the cover.
    await page.locator('[data-pdf-book-turn-edge="next"]').click();
    await waitForPdfBookRendered(page, [2, 3]);
    await expect(page.locator("[data-pdf-book-page]")).toHaveCount(2);
    await expect(page.locator("[data-pdf-book-page='1']")).toHaveCount(0);

    // Turning with the keyboard: back to the cover, forward to the spread
    // — one spread per press through the same turn path.
    await page.keyboard.press("ArrowLeft");
    await waitForPdfBookRendered(page, [1]);
    await page.keyboard.press("ArrowRight");
    await waitForPdfBookRendered(page, [2, 3]);

    // "Reload": the seeded app is one window per worker, so the journey's
    // reload is close/reopen (the position save needs the debounce to
    // land first). The persisted flag plus the saved position must land
    // on the same spread.
    await page.waitForTimeout(1500);
    await returnToLibrary(page);
    await openInReader(page, "A Minimal Manual (PDF)");
    await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: 30000 });
    await expect(page.getByTestId("pdf-book-view")).toBeVisible({ timeout: 30000 });
    await waitForPdfBookRendered(page, [2, 3]);
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 2 of 3", {
      timeout: 30000,
    });

    // Book mode off again: the scroll view is unchanged — the book is
    // gone, the same page renders through the slot pipeline, and the
    // zoom controls are back.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false", { timeout: 30000 });
    await expect(page.getByTestId("pdf-book-view")).toBeHidden();
    await expect(page.locator('[data-testid="pdf-book-canvas"]')).toHaveCount(0);
    await waitForRendered(page, 2);
    await firstPdfCanvas(page).waitFor({ state: "attached", timeout: 30000 });
    expect(await canvasIsNonBlank(page, 2)).toBe(true);
    await expect(page.getByTestId("pdf-zoom-in")).toBeVisible();

    // Leave the fixture at its first page: the seeded phase shares one app
    // per worker, so a mid-document position would leak into later specs.
    await page.keyboard.press("Home");
    await expect(page.getByTestId("pdf-page-indicator")).toHaveText("Page 1 of 3", {
      timeout: 30000,
    });
    await page.waitForTimeout(1500);
    await returnToLibrary(page);
  });

  test("turns an EPUB book by spread, instantly, reduced motion or not", async ({ page }) => {
    await openInReader(page, "A Minimal Book (EPUB)");
    const host = page.locator("div[data-epub-host]");
    await host.waitFor({ state: "attached", timeout: 30000 });
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });

    // Pin the start at the first chapter through the contents drawer — the
    // shared session may carry a mid-book position from an earlier spec,
    // and the forward turn below needs headroom ahead of the start. The
    // jump closes the drawer behind itself.
    await openReaderNavigation(page);
    await page.getByTestId("toc-item-0").click();
    await page.getByTestId("reader-nav").waitFor({ state: "detached", timeout: 30000 });
    await expect
      .poll(
        async () => {
          const raw = await epubLocator(page);
          return raw ? ((JSON.parse(raw) as { href?: string }).href ?? "") : "";
        },
        { timeout: 30000, message: "epub never landed on the first chapter" },
      )
      .toContain("chapter1.xhtml");

    // Book mode on: the surface derives the paginated two-column flow and
    // the turn layer mounts over it with the assistive-tech contract.
    const toggle = page.getByTestId("reader-book-mode");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: 30000 });
    await expect(page.getByTestId("epub-reader")).toHaveAttribute("data-layout", "paginated", {
      timeout: 30000,
    });
    await expect(page.getByRole("region", { name: BOOK_SPREAD_LABEL })).toBeVisible();
    await expect(page.getByRole("button", { name: BOOK_TURN_LABELS.next }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: BOOK_TURN_LABELS.prev }).first()).toBeVisible();

    const startSection = Number((await currentSection(page)) ?? "0");
    const startFraction = (await engineFraction(page)) ?? "0";

    // Advancing a spread through the labelled next action is instant:
    // the reported position moves past where the book was open, and no
    // turn phase exists at any point — not mid-turn, not after.
    await page.locator('[data-epub-book-turn-edge="next"]').click();
    expect(await turnPhaseAttributes(page)).toBe(0);
    await expect
      .poll(() => engineMovedPast(page, startSection, startFraction), { timeout: 30000 })
      .toBe(true);
    expect(await turnPhaseAttributes(page)).toBe(0);

    // Reduced motion: the same instant spread change — the position
    // moves back, still with no turn phase published.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect
      .poll(
        () => page.evaluate(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches),
        {
          timeout: 30000,
        },
      )
      .toBe(true);
    await page.waitForTimeout(500); // the app applies the live media query to its turn adapter
    await page.locator('[data-epub-book-turn-edge="prev"]').click();
    await expect
      .poll(() => engineMovedPast(page, startSection, startFraction), { timeout: 30000 })
      .toBe(false);
    expect(await turnPhaseAttributes(page)).toBe(0);

    // The window is shared per worker: hand the media emulation back.
    await page.emulateMedia({ reducedMotion: null });
    await returnToLibrary(page);
  });
});
