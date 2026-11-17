import fs from "node:fs";
import path from "node:path";

import { expect, test, type Page } from "../fixtures/electron-app.js";

import { ensureLibrary, openInReader, returnToLibrary } from "./helpers.js";

/**
 * Reader regressions from the licensed-corpus survey (docs/COVERAGE.md,
 * EPUB reader lib row): real-world EPUBs keep manifest-XHTML in .html
 * members with mangled or missing XML declarations and named HTML entities,
 * and the engine's wedge-rebuild path dropped the user theme. Each fixture
 * is a generated, committed miniature of one failing shape.
 */

const SECTION_COUNTS = {
  "Reader HTML Members": 3,
  "Reader Mangled Prolog": 3,
  "Reader HTML Entities": 2,
  "Reader Theme Sections": 6,
} as const;

/** Text of the frame currently on stage, or "" before init. */
async function stagedFrameText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const frames = [
      ...(document.querySelector("[data-epub-host]")?.querySelectorAll("iframe") ?? []),
    ];
    let best = "";
    for (const frame of frames) {
      try {
        const text = frame.contentDocument?.body?.innerText ?? "";
        if (text.length > best.length) best = text;
      } catch {}
    }
    return best;
  });
}

/** The theme variable the appearance system lands on section frames. */
async function frameThemeBackground(page: Page): Promise<string> {
  return page.evaluate(() => {
    const frames = [
      ...(document.querySelector("[data-epub-host]")?.querySelectorAll("iframe") ?? []),
    ];
    for (const frame of frames) {
      try {
        const value =
          frame.contentDocument?.documentElement?.style.getPropertyValue(
            "--USER__backgroundColor",
          ) ?? "";
        if (value) return value;
      } catch {}
    }
    return "";
  });
}

test.describe("reader regressions from real-world EPUB shapes", () => {
  for (const [title, sectionCount] of Object.entries(SECTION_COUNTS)) {
    test(`pages through every section of ${title}`, async ({ page }) => {
      await openInReader(page, `${title} (EPUB)`);
      const host = page.locator("div[data-epub-host]");
      await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });

      const lastSection = String(sectionCount - 1);

      // Every spine crossing must render and the engine must stay ready (blank frames were the UAT symptom).
      for (let i = 0; i < sectionCount * 4 + 4; i += 1) {
        if (
          (await page.evaluate(() =>
            document.querySelector("[data-epub-host]")?.getAttribute("data-epub-section"),
          )) === lastSection
        ) {
          const settledSection = await page.evaluate(() =>
            document.querySelector("[data-epub-host]")?.getAttribute("data-epub-section"),
          );
          if (settledSection === lastSection) break;
        }
        await page.keyboard.press("ArrowRight");
        await page.waitForTimeout(600);
      }
      await expect
        .poll(
          () =>
            page.evaluate(
              () =>
                document.querySelector("[data-epub-host]")?.getAttribute("data-epub-section") ?? "",
            ),
          {
            timeout: 30000,
          },
        )
        .toBe(lastSection);
      await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });
      await expect.poll(() => stagedFrameText(page), { timeout: 30000 }).not.toBe("");
    });
  }

  test("keeps the library layout stable with the regression corpus", async ({ page }) => {
    // Scrollbar-gutter feedback: boundary-height content reflows forever; any drift fails.
    await ensureLibrary(page);
    const card = page.locator('[aria-label="Reader Mangled Prolog (EPUB)"]');
    await card.waitFor({ state: "visible", timeout: 30000 });
    await page.waitForTimeout(1500);
    const boxOf = async (): Promise<string> => {
      const boxes = await page.evaluate(() =>
        Array.from(document.querySelectorAll("[data-testid=book-card]")).map((el) => {
          const r = el.getBoundingClientRect();
          return `${Math.round(r.x * 2)}:${Math.round(r.y * 2)}`;
        }),
      );
      return boxes.join("|");
    };
    const before = await boxOf();
    await page.waitForTimeout(2000);
    expect(await boxOf(), "library layout oscillates").toBe(before);
  });

  test("keeps the user theme across spine crossings and back-navigation", async ({ page }) => {
    await openInReader(page, "Reader Theme Sections (EPUB)");
    const host = page.locator("div[data-epub-host]");
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });

    await page.getByTestId("appearance-trigger").click();
    await expect(page.getByTestId("appearance-content")).toBeVisible({ timeout: 30000 });
    await page.getByTestId("pref-theme").getByText("Dark", { exact: true }).click();
    await expect.poll(() => frameThemeBackground(page), { timeout: 30000 }).toBe("#101013");

    // The theme must survive every frame rebuild; the wedge path starts a fresh
    // navigator with empty preferences and used to drop it.
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(500);
    }
    const deepestSection = await page.evaluate(() =>
      document.querySelector("[data-epub-host]")?.getAttribute("data-epub-section"),
    );
    expect(Number(deepestSection)).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < 10; i += 1) {
      await page.keyboard.press("ArrowLeft");
      await page.waitForTimeout(500);
    }
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });
    await expect.poll(() => frameThemeBackground(page), { timeout: 30000 }).toBe("#101013");
    await returnToLibrary(page);
  });

  test("keeps the seek's anchor relocate out of the progress bar", async ({ page }) => {
    const denseFixture = path.join(
      process.env.TEST_LIBRARY_PATH ?? "",
      "reader-dense-sections.epub",
    );
    test.skip(!fs.existsSync(denseFixture), "dense fixture not generated on this run");
    await openInReader(page, "Reader Dense Sections (EPUB)");
    const host = page.locator("div[data-epub-host]");
    await expect(host).toHaveAttribute("data-epub-state", "ready", { timeout: 30000 });

    // A cross-section jump reaches the engine as two relocates: the section
    // anchors at its top, then the navigator reports the deep locator. Painting
    // both swung the slider through the section start (the UAT flash).
    await page.evaluate(() => {
      const w = window as typeof window & { __thumbValues?: string[] };
      w.__thumbValues = [];
      const thumb = document.querySelector(
        "[data-testid=reader-progress] [data-slot=slider-thumb]",
      );
      w.__thumbValues.push(thumb?.getAttribute("aria-valuenow") ?? "");
      new MutationObserver(() => {
        const value = thumb?.getAttribute("aria-valuenow") ?? "";
        const values = (window as typeof window & { __thumbValues?: string[] }).__thumbValues!;
        if (values.at(-1) !== value) values.push(value);
      }).observe(thumb!, { attributes: true, attributeFilter: ["aria-valuenow"] });
    });

    const bar = page.getByTestId("reader-progress");
    const box = (await bar.boundingBox())!;

    // The jump hold dispatches only the landing, so painted values must be within
    // a step of the click, landing, or previous landing.
    let previousLanding: number | null = null;
    for (const fraction of [0.1, 0.8, 0.3, 0.95]) {
      const before = await page.evaluate(
        () => (window as typeof window & { __thumbValues?: string[] }).__thumbValues!.length,
      );
      await bar.click({
        position: { x: Math.round(box.width * fraction), y: Math.round(box.height / 2) },
      });
      // The settle wait must cover the hold's quiet window plus a slow frame load.
      await page.waitForTimeout(2000);
      const segment = (
        await page.evaluate(
          () => (window as typeof window & { __thumbValues?: string[] }).__thumbValues!,
        )
      )
        .slice(before)
        .map(Number);
      const clicked = fraction * 100;
      const landing = segment.at(-1) ?? clicked;
      for (const painted of segment) {
        const legal =
          Math.abs(painted - clicked) <= 1 ||
          Math.abs(painted - landing) <= 1 ||
          (previousLanding !== null && Math.abs(painted - previousLanding) <= 1);
        expect(legal, `seek ${clicked}% painted a foreign intermediate ${painted}%`).toBe(true);
      }
      previousLanding = landing;
    }
  });
});
