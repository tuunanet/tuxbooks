/**
 * Pure PDF document layout math — no React, no DOM. Every offset, height, and
 * scale used by the continuous reader is computed here so it can be unit
 * tested without a browser.
 *
 * Coordinate system: page sizes are in PDF page units (points) at scale 1;
 * slot geometry is in CSS pixels in document-container coordinates. Slot tops
 * do NOT include the inter-page gap: `top(page n+1) = bottom(page n) + gap`,
 * so an offset inside a gap belongs to the page above it.
 */

/** Size of one PDF page in page units (points) at scale 1. */
export interface PageSize {
  pageNumber: number;
  width: number;
  height: number;
}

/** Displayed pixel geometry of one page slot in document coordinates. */
export interface LayoutSlot {
  pageNumber: number;
  top: number;
  width: number;
  height: number;
}

/** Vertical space between consecutive page slots, in CSS pixels. */
export const PAGE_GAP_PX = 8;

/** Fill the whole document with an estimate derived from one known page. */
export function estimatePageSizes(
  pageCount: number,
  reference: { width: number; height: number },
): PageSize[] {
  return Array.from({ length: pageCount }, (_, index) => ({
    pageNumber: index + 1,
    width: reference.width,
    height: reference.height,
  }));
}

/** Convert page-unit sizes into displayed pixel sizes at a render scale. */
export function displayedSizes(sizes: PageSize[], scale: number): PageSize[] {
  return sizes.map((size) => ({
    pageNumber: size.pageNumber,
    width: size.width * scale,
    height: size.height * scale,
  }));
}

/** Compute slot tops from displayed sizes; the first page starts at 0. */
export function layoutSlots(sizes: PageSize[], gapPx: number = PAGE_GAP_PX): LayoutSlot[] {
  let top = 0;
  return sizes.map((size) => {
    const slot: LayoutSlot = {
      pageNumber: size.pageNumber,
      top,
      width: size.width,
      height: size.height,
    };
    top += size.height + gapPx;
    return slot;
  });
}

/** Total height of the laid-out document (last slot bottom). */
export function documentHeight(slots: LayoutSlot[]): number {
  const last = slots.at(-1);
  return last ? last.top + last.height : 0;
}

/**
 * The page whose slot contains `offset` (binary search over slot tops). An
 * offset inside the gap below a page belongs to that page.
 */
export function pageAtOffset(offset: number, slots: LayoutSlot[]): number | null {
  if (slots.length === 0) return null;
  let low = 0;
  let high = slots.length - 1;
  let candidate = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const probe = slots[mid];
    if (probe && probe.top <= offset) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  const slot = slots[candidate];
  return slot?.pageNumber ?? null;
}

/** Document offset of a page's top edge, or null outside the document. */
export function offsetForPage(pageNumber: number, slots: LayoutSlot[]): number | null {
  const slot = slots.find((candidate) => candidate.pageNumber === pageNumber);
  return slot ? slot.top : null;
}

/** Clamp a scroll offset to the document, given the visible viewport height. */
export function clampOffset(offset: number, viewportHeight: number, docHeight: number): number {
  const max = Math.max(0, docHeight - viewportHeight);
  return Math.max(0, Math.min(max, offset));
}

/**
 * Re-anchor a scroll offset after slot geometry changed (lazy size
 * corrections): shift by the movement of the top edge of the page that
 * contained the offset, so already-read content stays visually stationary.
 */
export function compensateOffset(
  offset: number,
  before: LayoutSlot[],
  after: LayoutSlot[],
): number {
  const pageNumber = pageAtOffset(offset, before);
  if (pageNumber === null) return offset;
  const previousSlot = before.find((slot) => slot.pageNumber === pageNumber);
  const updatedSlot = after.find((slot) => slot.pageNumber === pageNumber);
  if (!previousSlot || !updatedSlot) return offset;
  return offset + (updatedSlot.top - previousSlot.top);
}
