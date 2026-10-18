/**
 * PDF mouse-drag selection on a page whose reported font sizes lie
 * (tests/fixtures/books/dense.pdf draws its text with a degenerate text
 * matrix: tiny Tf inside a large Tm scale, so the char boxes stand ~14
 * units while FPDFText_GetFontSize reports 1.152). When the text layer
 * trusted the reported size, the glyphs laid out into a sliver of the hit
 * box and every mouse drag collapsed to a caret (selection hit-testing
 * works in text-layout space). Guards the box-height font derivation plus
 * the run-width scaleX in `renderPdfTextLayer`.
 */
import { expect, test } from "../fixtures/electron-app.js";
import { openInReader, slotStates } from "./helpers.js";

test("drags select real text across lines on a degenerate-font-size page", async ({ page }) => {
  await openInReader(page, "A Dense Fixture (PDF)");
  await expect
    .poll(async () => (await slotStates(page)).length, { timeout: 30000 })
    .toBeGreaterThan(0);
  await expect
    .poll(
      () =>
        page.evaluate(
          () => document.querySelectorAll('[data-pdf-slot="1"] [data-pdf-text-layer] span').length,
        ),
      { timeout: 30000 },
    )
    .toBeGreaterThan(10);

  // The dense page's body lines (long spans; the page title is short).
  const lines = await page.evaluate(() => {
    const spans = Array.from(
      document.querySelectorAll('[data-pdf-slot="1"] [data-pdf-text-layer] span'),
    );
    return spans
      .map((span) => {
        const r = span.getBoundingClientRect();
        return { text: span.textContent ?? "", x: r.x, y: r.y, w: r.width, h: r.height };
      })
      .filter((line) => line.text.length > 40 && line.w > 100)
      .sort((a, b) => a.y - b.y);
  });
  expect(lines.length).toBeGreaterThanOrEqual(2);
  const [first, second] = lines;

  // Drag from the start of line 1 through the end of line 2 — the gesture
  // from the bug report.
  const startX = first!.x + 2;
  const startY = first!.y + first!.h / 2;
  const endX = second!.x + second!.w - 2;
  const endY = second!.y + second!.h / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  for (let step = 1; step <= 12; step++) {
    const t = step / 12;
    await page.mouse.move(startX + (endX - startX) * t, startY + (endY - startY) * t);
  }
  await page.mouse.up();
  await page.waitForTimeout(300); // the reader's capture defers one tick

  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected).toContain(first!.text.trim().slice(0, 20));
  expect(selected).toContain(second!.text.trim().slice(0, 20));

  // The painted selection must track the text, not flood past it: every
  // selection rect stays within the crossed lines' horizontal extent (small
  // tolerance for caret rounding). A rect wider than the line means the
  // span's text run overflows its hit box.
  const rects = await page.evaluate(() => {
    const sel = window.getSelection()!;
    return Array.from(sel.getRangeAt(0).getClientRects()).map((r) => ({
      x: r.x,
      w: r.width,
    }));
  });
  expect(rects.length).toBeGreaterThan(0);
  const maxRight = Math.max(first!.x + first!.w, second!.x + second!.w);
  const minLeft = Math.min(first!.x, second!.x);
  for (const rect of rects) {
    expect(rect.x).toBeGreaterThanOrEqual(minLeft - 8);
    expect(rect.x + rect.w).toBeLessThanOrEqual(maxRight + 8);
  }
});
