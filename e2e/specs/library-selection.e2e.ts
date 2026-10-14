import { expect, test, type Page } from "../fixtures/electron-app.js";

import { waitForLibraryView } from "./helpers.js";

/**
 * Selection ring at the grid edge: a selected card paints an outset ring
 * (ring-2, a box-shadow spread outside the border box), while the grid
 * scroller clips at its scrollport. A card in the first or last column sits
 * flush against that clip, so the ring paints past it and comes out cut off.
 *
 * The probe measures the card's painted shadow extent against the live
 * scrollport clip and asserts the ring stays inside it.
 */
interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface RingProbe {
  /** Outward extent of the card's outset box-shadow layers (px). */
  extent: number;
  /** The selected card button. */
  card: Rect;
  /** The card's grid slot (its parent grid item): the column it occupies. */
  cell: Rect;
  /** The row grid the slot belongs to; full width of the grid. */
  row: Rect;
  /** The scroll container's clip rect (padding box, scrollbar excluded). */
  clip: Rect;
  /** How far the painted ring reaches past the clip; > 0 means cut off. */
  overflow: { top: number; right: number; bottom: number; left: number };
}

/** Grid scroll container in grid view (list view exposes book-list). */
const GRID_SELECTOR = '[data-testid="book-grid"]';

/** Card wrapper index to card button selector. */
function cardSelector(cardIndex: number): string {
  return `[data-card-index="${cardIndex}"] [data-book-card]`;
}

/**
 * Wrapper indexes of the leftmost and rightmost card in the top row: the
 * first/last column slots at the grid's edges.
 */
async function topRowEdges(page: Page): Promise<{ leftIndex: number; rightIndex: number }> {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[data-book-card]"));
    if (cards.length === 0) throw new Error("no book cards rendered");
    const top = Math.min(...cards.map((card) => card.getBoundingClientRect().top));
    const row = cards.filter((card) => Math.abs(card.getBoundingClientRect().top - top) <= 1);
    const index = (card: HTMLElement) => {
      const value = card.closest("[data-card-index]")?.getAttribute("data-card-index");
      if (value == null) throw new Error("card is missing its data-card-index wrapper");
      return Number(value);
    };
    const leftmost = row.reduce((a, b) =>
      a.getBoundingClientRect().left <= b.getBoundingClientRect().left ? a : b,
    );
    const rightmost = row.reduce((a, b) =>
      a.getBoundingClientRect().right >= b.getBoundingClientRect().right ? a : b,
    );
    return { leftIndex: index(leftmost), rightIndex: index(rightmost) };
  });
}

/**
 * Painted-ring geometry of one card against the grid scrollport's clip rect.
 *
 * Box-shadow layers come from computed style: colour functions nest and
 * carry commas (color-mix), so parentheses collapse before the layers split,
 * and each layer contributes its spread plus half its blur outward. Inset
 * layers paint inside the border box and never clip, so they drop out.
 */
async function probeRing(page: Page, cardIndex: number): Promise<RingProbe> {
  return page.evaluate(
    ([selector, indexRaw]) => {
      const index = Number(indexRaw);
      const scroller = document.querySelector<HTMLElement>(selector);
      const card = document.querySelector<HTMLElement>(
        `[data-card-index="${index}"] [data-book-card]`,
      );
      if (!scroller || !card) throw new Error("grid scroller or card not found");
      const cell = card.parentElement;
      const row = card.closest(".grid");
      if (!cell || !row) throw new Error("card's grid slot or row not found");

      // Collapsing one nesting level at a time must drop the parentheses too,
      // or replacing them with "()" would match forever and wedge the renderer.
      let shadow = getComputedStyle(card).boxShadow;
      while (/\([^()]*\)/.test(shadow)) shadow = shadow.replace(/\([^()]*\)/g, " ");
      const extents = shadow
        .split(",")
        .filter((layer) => !layer.includes("inset"))
        .map((layer) => {
          const [, , blur, spread] = [...layer.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]));
          if (spread === undefined) return 0;
          return Math.max(0, spread) + Math.max(0, blur ?? 0) / 2;
        });
      const extent = extents.length > 0 ? Math.max(...extents) : 0;

      const rect = (el: Element): Rect => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      const scrollerRect = scroller.getBoundingClientRect();
      const cardRect = rect(card);
      const clip: Rect = {
        left: scrollerRect.left,
        top: scrollerRect.top,
        right: scrollerRect.left + scroller.clientWidth,
        bottom: scrollerRect.top + scroller.clientHeight,
      };
      return {
        extent,
        card: cardRect,
        cell: rect(cell),
        row: rect(row),
        clip,
        overflow: {
          top: clip.top - (cardRect.top - extent),
          right: cardRect.right + extent - clip.right,
          bottom: cardRect.bottom + extent - clip.bottom,
          left: clip.left - (cardRect.left - extent),
        },
      };
    },
    [GRID_SELECTOR, String(cardIndex)] as const,
  );
}

/** Open the library sort select and pick an option by its visible label. */
async function setSort(page: Page, label: string): Promise<void> {
  await page.getByTestId("library-sort").click();
  await page.getByRole("option", { name: label }).click();
  await expect(page.getByTestId("library-sort")).toContainText(label);
}

test.describe("library grid selection ring", () => {
  test("a selected card at the grid's left or right edge shows its full ring", async ({ page }) => {
    await waitForLibraryView(page);
    let sorted = false;
    try {
      // Title order puts cover-bearing books in the first and last column of
      // the top row. The default order ends the row with an EPUB whose
      // placeholder cover leaves the card short of its slot, so its ring
      // never reaches the grid edge in the first place.
      await setSort(page, "Title");
      sorted = true;
      // Scroll position survives section navigation; the top row must sit on
      // the grid's top edge for the top-edge probe to mean anything.
      await page.evaluate((selector) => {
        const grid = document.querySelector<HTMLElement>(selector);
        if (grid) grid.scrollTop = 0;
      }, GRID_SELECTOR);

      const { leftIndex, rightIndex } = await topRowEdges(page);

      const leftCard = page.locator(cardSelector(leftIndex));
      await leftCard.click();
      await expect(leftCard).toHaveAttribute("aria-pressed", "true");
      const left = await probeRing(page, leftIndex);

      const rightCard = page.locator(cardSelector(rightIndex));
      await rightCard.click();
      await expect(rightCard).toHaveAttribute("aria-pressed", "true");
      const right = await probeRing(page, rightIndex);

      // Precondition: the card must fill its slot in the outermost column,
      // or its ring never reaches the grid edge and the probe below would
      // pass without covering the reported case.
      expect(
        left.cell.left - left.row.left,
        `top-left card's slot is ${left.cell.left - left.row.left}px from the grid's left edge; expected the first column`,
      ).toBeLessThanOrEqual(1);
      expect(
        left.card.left - left.cell.left,
        `top-left card is ${left.card.left - left.cell.left}px short of its slot, so its ring stops short of the grid edge`,
      ).toBeLessThanOrEqual(1);
      expect(
        right.row.right - right.cell.right,
        `top-right card's slot is ${right.row.right - right.cell.right}px from the grid's right edge; expected the last column`,
      ).toBeLessThanOrEqual(1);
      expect(
        right.cell.right - right.card.right,
        `top-right card is ${right.cell.right - right.card.right}px short of its slot, so its ring stops short of the grid edge`,
      ).toBeLessThanOrEqual(1);

      // The reported symptom: the painted ring must stay inside the clip.
      expect(
        left.overflow.left,
        `selection ring is cut off past the grid's left edge by ${left.overflow.left}px ` +
          `(ring extent ${left.extent}px, ${left.card.left - left.clip.left}px from the clip)`,
      ).toBeLessThanOrEqual(0.01);
      expect(
        right.overflow.right,
        `selection ring is cut off past the grid's right edge by ${right.overflow.right}px ` +
          `(ring extent ${right.extent}px, ${right.clip.right - right.card.right}px from the clip)`,
      ).toBeLessThanOrEqual(0.01);
      for (const [edge, probe] of [
        ["left", left],
        ["right", right],
      ] as const) {
        expect(
          probe.overflow.top,
          `selection ring of the ${edge}-edge card is cut off past the grid's top edge by ` +
            `${probe.overflow.top}px (ring extent ${probe.extent}px)`,
        ).toBeLessThanOrEqual(0.01);
      }
    } finally {
      // The shared BrowserWindow carries this view state into later specs.
      if (sorted) await setSort(page, "Recently Added");
    }
  });
});
