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

/** The three dynamic fit modes: scale recomputed from the measured viewport. */
export type FitZoomMode = "fit-width" | "fit-page" | "fit-auto";

/**
 * Zoom mode of the PDF reader. The fit modes are dynamic: the scale is
 * continuously recomputed from the measured viewport (resize, sidebar
 * toggles) and never stored. `custom` is a fixed scale (1 = 100%).
 */
export type ZoomMode = FitZoomMode | "custom";

/** Request for {@link computePdfScale}: the zoom state plus page references. */
export interface PdfScaleRequest {
  mode: ZoomMode;
  /** Custom-mode ladder level; ignored by the fit modes. */
  level: number;
  /** Document-wide reference page (page 1); null before geometry is known. */
  reference: Pick<PageSize, "width" | "height"> | null;
  /**
   * The current page's own size while presentation mode is active: the page
   * is fit inside the area (both axes) from the page being read, so
   * mixed-size documents rescale per page and any page shape stays visible.
   */
  presentationPage: Pick<PageSize, "width" | "height"> | null;
}

/**
 * The layout scale for one render pass (pure — unit-tested without a
 * browser). Presentation mode fits the whole current page inside the
 * measured area (both axes, page-keyed) so any page shape stays fully
 * visible; every other mode is document-wide (page-1 reference) so ordinary
 * navigation never rescales the layout mid-document. Unmeasurable inputs
 * fall back to 1 so callers never render at a zero scale.
 */
export function computePdfScale(
  request: PdfScaleRequest,
  areaWidth: number,
  viewportHeight: number,
): number {
  if (request.presentationPage) {
    return fitPageScale(
      areaWidth,
      viewportHeight,
      request.presentationPage.width,
      request.presentationPage.height,
    );
  }
  const reference = request.reference;
  if (!reference) return 1;
  switch (request.mode) {
    case "fit-width":
      return fitWidthScale(areaWidth, reference.width);
    case "fit-page":
      return fitPageScale(areaWidth, viewportHeight, reference.width, reference.height);
    case "fit-auto":
      return autoFitScale(areaWidth, viewportHeight, reference.width, reference.height);
    case "custom":
      return clampZoom(request.level);
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
 * `availableHeight` CSS pixels — the height axis of fit page and Auto Fit.
 * Falls back to 1 when unmeasurable.
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
 * Auto Fit scale (Okular's `ZoomFitAuto` in continuous mode): fit the page
 * width when the area is relatively much wider than the page, otherwise fit
 * the whole page. `AUTO_FIT_ASPECT_RATIO_RELATION` is Okular's 1.25: below
 * its reciprocal the area's aspect differs enough from the page's to prefer
 * width, elsewhere contain. Falls back to 1 when unmeasurable.
 */
export const AUTO_FIT_ASPECT_RATIO_RELATION = 1.25;

export function autoFitScale(
  availableWidth: number,
  availableHeight: number,
  pageWidth: number,
  pageHeight: number,
): number {
  if (pageWidth <= 0 || pageHeight <= 0) return 1;
  const areaAspect = availableHeight / availableWidth;
  const pageAspect = pageHeight / pageWidth;
  const relation = areaAspect / pageAspect;
  if (relation < 1 / AUTO_FIT_ASPECT_RATIO_RELATION) {
    return fitWidthScale(availableWidth, pageWidth);
  }
  return fitPageScale(availableWidth, availableHeight, pageWidth, pageHeight);
}

/**
 * Okular's zoom presets (`kZoomValues`), as scales (1 = 100%): the
 * percentages offered in the zoom dropdown, 12% through 10000%. Typed
 * values may sit between presets; the list seeds the dropdown and the
 * keyboard stepping.
 */
export const ZOOM_PRESETS = [
  0.12, 0.25, 0.33, 0.5, 0.66, 0.75, 1, 1.25, 1.5, 2, 4, 8, 16, 25, 50, 100,
] as const;

/** Smallest custom scale (12%, Okular's floor). */
export const MIN_ZOOM = 0.12;

/** Largest custom scale (10000%, matching Okular's tiled-document cap). */
export const MAX_ZOOM = 100;

/** The Ctrl+0 reset level (100%). */
export const DEFAULT_ZOOM_LEVEL = 1;

/** Clamp a custom scale onto the supported range; unmeasurable values reset to 100%. */
export function clampZoom(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return DEFAULT_ZOOM_LEVEL;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));
}

/**
 * Parse a typed zoom percentage into a scale, Okular-style: a trailing `%`
 * (or its Arabic spelling) and stray `&` accelerators are dropped before the
 * number is read. Returns null for anything that is not a positive number,
 * so callers can keep the current zoom.
 */
export function parseZoomPercent(text: string): number | null {
  const normalized = text.replace(/[%٪&]/g, "").trim();
  if (normalized === "") return null;
  const percent = Number(normalized);
  if (!Number.isFinite(percent) || percent <= 0) return null;
  return percent / 100;
}

/**
 * Format a scale as the display percentage: at most one decimal, no trailing
 * `.0` (Okular's `makePrettyZoomString`). 0.125 → "12.5", 2 → "200".
 */
export function formatZoomPercent(scale: number): string {
  const percent = Math.round(scale * 1000) / 10;
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
}

/**
 * Nearest preset at or above/below `scale`, stepping `direction` (+1 in,
 * -1 out) entries from there. Clamps at both ends so rapid input never
 * escapes the range. Off-preset scales (a dynamic fit scale, a typed value)
 * snap onto the nearest preset first, so zooming out of a fit mode continues
 * from where the page actually is.
 */
export function stepZoomLevel(scale: number, direction: 1 | -1): number {
  let index = 0;
  for (let i = 0; i < ZOOM_PRESETS.length; i++) {
    if ((ZOOM_PRESETS[i] as number) <= scale) index = i;
  }
  if (direction === 1) {
    while (index < ZOOM_PRESETS.length - 1 && (ZOOM_PRESETS[index] as number) <= scale) index++;
  } else {
    while (index > 0 && (ZOOM_PRESETS[index] as number) >= scale) index--;
  }
  return ZOOM_PRESETS[index] as number;
}

/** One wheel "line" in CSS pixels, for deltaMode 1 (lines). */
const WHEEL_LINE_HEIGHT_PX = 16;

/**
 * Wheel delta in CSS pixels: line (deltaMode 1) and page (deltaMode 2)
 * deltas are normalized, pixel deltas pass through. `pagePx` is the
 * scrolling container's viewport height. The same convention the axis-lock
 * wheel hook applies to scrolling, shared here for the Ctrl+wheel zoom
 * math.
 */
export function wheelDeltaPx(deltaY: number, deltaMode: number, pagePx: number): number {
  if (deltaMode === 1) return deltaY * WHEEL_LINE_HEIGHT_PX;
  if (deltaMode === 2) return deltaY * (pagePx > 0 ? pagePx : 1);
  return deltaY;
}

/** Zoom-per-event cap: one Ctrl+wheel event moves at most 300px of normalized
 * delta (three Chromium notches), so a free-spinning wheel or a huge
 * programmatic delta cannot leap across the whole ladder in one tick.
 */
const WHEEL_MAX_DELTA_PX = 300;

/**
 * Continuous wheel zoom (Okular/pdf.js/Evince feel): the scale multiplies by
 * 1.2 per standard 100px notch and tracks small trackpad deltas
 * exponentially, instead of snapping onto the preset ladder. A negative
 * deltaY (wheel up / pinch out) zooms in. Line (deltaMode 1) and page
 * (deltaMode 2) deltas are normalized to pixels first — the wheel-scale
 * normalization shared with useAxisLockedWheel, with the viewport height
 * passed in as `pagePx` — then clamped to ±300px. The result never leaves
 * the supported zoom range.
 */
export function wheelZoomScale(
  scale: number,
  deltaY: number,
  deltaMode: number,
  pagePx = 1,
): number {
  const deltaPx = Math.min(
    WHEEL_MAX_DELTA_PX,
    Math.max(-WHEEL_MAX_DELTA_PX, wheelDeltaPx(deltaY, deltaMode, pagePx)),
  );
  return clampZoom(scale * 1.2 ** (-deltaPx / 100));
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

/** A rectangle in one coordinate space: document scroll coords or page-local CSS px. */
export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * The part of one page the reader should rasterize: the page's intersection
 * with the scroll viewport, expanded by `overscanPx` on every side, clamped to
 * the page, then snapped outward to a `stepPx` grid. Returns null when the page
 * does not intersect the viewport. `page` and `viewport` are in the same
 * coordinate space (document scroll coordinates); the result is page-local CSS
 * pixels, the space the slot wrapper and the text layer use.
 *
 * The overscan keeps a small scroll from forcing a new raster, and the grid
 * keeps the region (and with it the render key) stable across sub-step
 * scrolling. `stepPx` of 0 disables snapping.
 */
export function visiblePageRegion(
  page: Rect,
  viewport: Rect,
  overscanPx: number,
  stepPx = 0,
): Rect | null {
  const top = Math.max(page.top, viewport.top - overscanPx);
  const bottom = Math.min(page.top + page.height, viewport.top + viewport.height + overscanPx);
  if (bottom <= top) return null;
  const left = Math.max(page.left, viewport.left - overscanPx);
  const right = Math.min(page.left + page.width, viewport.left + viewport.width + overscanPx);
  if (right <= left) return null;

  let localLeft = left - page.left;
  let localTop = top - page.top;
  let localRight = right - page.left;
  let localBottom = bottom - page.top;
  if (stepPx > 0) {
    localLeft = Math.max(0, Math.floor(localLeft / stepPx) * stepPx);
    localTop = Math.max(0, Math.floor(localTop / stepPx) * stepPx);
    localRight = Math.min(page.width, Math.ceil(localRight / stepPx) * stepPx);
    localBottom = Math.min(page.height, Math.ceil(localBottom / stepPx) * stepPx);
  }
  return {
    left: localLeft,
    top: localTop,
    width: Math.max(1, localRight - localLeft),
    height: Math.max(1, localBottom - localTop),
  };
}

/** True when `rendered` already covers `wanted` (skips a redundant region raster). */
export function regionCovers(rendered: Rect, wanted: Rect): boolean {
  const tolerance = 0.5;
  return (
    rendered.left <= wanted.left + tolerance &&
    rendered.top <= wanted.top + tolerance &&
    rendered.left + rendered.width >= wanted.left + wanted.width - tolerance &&
    rendered.top + rendered.height >= wanted.top + wanted.height - tolerance
  );
}
