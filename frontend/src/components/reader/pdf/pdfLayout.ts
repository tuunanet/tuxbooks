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

/**
 * Zoom mode of the PDF reader. The fit modes are dynamic: the scale is
 * continuously recomputed from the measured viewport (resize, sidebar
 * toggles) and never stored. `custom` is a fixed level on the zoom ladder
 * (1 = 100%).
 */
export type ZoomMode = "fit-width" | "fit-page" | "fit-height" | "custom";

/** Request for {@link computePdfScale}: the zoom state plus page references. */
export interface PdfScaleRequest {
  mode: ZoomMode;
  /** Custom-mode ladder level; ignored by the fit modes. */
  level: number;
  /** Document-wide reference page (page 1); null before geometry is known. */
  reference: Pick<PageSize, "width" | "height"> | null;
  /**
   * The current page's own size while presentation mode is active: fit
   * height is computed from the page being read, so mixed-size documents
   * rescale per page.
   */
  presentationPage: Pick<PageSize, "width" | "height"> | null;
}

/**
 * The layout scale for one render pass (pure — unit-tested without a
 * browser). Presentation mode always fit-heights the current page; every
 * other mode is document-wide (page-1 reference) so ordinary navigation
 * never rescales the layout mid-document. Unmeasurable inputs fall back
 * to 1 so callers never render at a zero scale.
 */
export function computePdfScale(
  request: PdfScaleRequest,
  areaWidth: number,
  viewportHeight: number,
): number {
  if (request.presentationPage) {
    return fitHeightScale(viewportHeight, request.presentationPage.height);
  }
  const reference = request.reference;
  if (!reference) return 1;
  switch (request.mode) {
    case "fit-width":
      return fitWidthScale(areaWidth, reference.width);
    case "fit-page":
      return fitPageScale(areaWidth, viewportHeight, reference.width, reference.height);
    case "fit-height":
      return fitHeightScale(viewportHeight, reference.height);
    case "custom":
      return request.level > 0 ? request.level : 1;
  }
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

/**
 * Scale that fits a page of `referencePageWidth` page units into
 * `availableWidth` CSS pixels. Falls back to 1 when either dimension is not
 * measurable (tests, hidden containers) so callers never scale to zero.
 */
export function fitWidthScale(availableWidth: number, referencePageWidth: number): number {
  if (availableWidth <= 0 || referencePageWidth <= 0) return 1;
  return availableWidth / referencePageWidth;
}

/**
 * Scale that fits a page of `referencePageHeight` page units into
 * `availableHeight` CSS pixels (dynamic fit-height mode — presentation
 * mode and the Ctrl+3 zoom mode). Falls back to 1 when unmeasurable.
 */
export function fitHeightScale(availableHeight: number, referencePageHeight: number): number {
  if (availableHeight <= 0 || referencePageHeight <= 0) return 1;
  return availableHeight / referencePageHeight;
}

/**
 * Scale that fits a whole page inside both dimensions at once (Ctrl+1):
 * the binding axis wins. Falls back to 1 when unmeasurable.
 */
export function fitPageScale(
  availableWidth: number,
  availableHeight: number,
  pageWidth: number,
  pageHeight: number,
): number {
  if (pageWidth <= 0 || pageHeight <= 0) return 1;
  return Math.min(
    fitWidthScale(availableWidth, pageWidth),
    fitHeightScale(availableHeight, pageHeight),
  );
}

/**
 * Discrete zoom ladder for the manual (custom) zoom mode. `Ctrl + +` /
 * `Ctrl + -` step between neighbors; the effective scale snaps onto the
 * nearest rung first, so zooming out of a fit mode continues from where
 * the page actually is.
 */
export const ZOOM_LADDER = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4] as const;

/** The Ctrl+0 reset level (100%). */
export const DEFAULT_ZOOM_LEVEL = 1;

/**
 * Nearest ladder entry at or above/below `scale`, stepping `direction`
 * (+1 in, -1 out) rungs from there. Clamps at both ends of the ladder so
 * rapid input never escapes the bounds.
 */
export function stepZoomLevel(scale: number, direction: 1 | -1): number {
  let index = 0;
  for (let i = 0; i < ZOOM_LADDER.length; i++) {
    if ((ZOOM_LADDER[i] as number) <= scale) index = i;
  }
  if (direction === 1) {
    while (index < ZOOM_LADDER.length - 1 && (ZOOM_LADDER[index] as number) <= scale) index++;
  } else {
    while (index > 0 && (ZOOM_LADDER[index] as number) >= scale) index--;
  }
  return ZOOM_LADDER[index] as number;
}

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

/**
 * Displayed geometry of one page thumbnail at a fixed cell width: the page
 * aspect is preserved, so mixed documents stack thumbnails of different
 * heights (reserving real space up front from measured-or-estimated sizes).
 * Degenerate page units fall back to a square cell so callers never divide
 * by zero.
 */
export function thumbnailGeometry(
  size: Pick<PageSize, "width" | "height">,
  cellWidth: number,
): { width: number; height: number } {
  if (size.width <= 0 || size.height <= 0) return { width: cellWidth, height: cellWidth };
  return { width: cellWidth, height: (cellWidth * size.height) / size.width };
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
