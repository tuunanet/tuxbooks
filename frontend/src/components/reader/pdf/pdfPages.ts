/** Reading position (0–100) → 1-based page number for a loaded document. */
export function positionToPage(position: number, pageCount: number): number {
  const clamped = Math.max(0, Math.min(100, position));
  return Math.min(Math.max(1, Math.round((clamped / 100) * (pageCount - 1)) + 1), pageCount);
}

/** 1-based page number → reading position (0–100). */
export function pageToPosition(page: number, pageCount: number): number {
  if (pageCount <= 1) return 0;
  return ((page - 1) / (pageCount - 1)) * 100;
}

/** Clamp a page number into the valid `[1, pageCount]` range. */
export function clampPage(page: number, pageCount: number): number {
  return Math.min(pageCount, Math.max(1, page));
}

/**
 * Parse a typed page number for a document with `pageCount` pages. Returns
 * null unless the trimmed input is a run of digits, and null for an empty
 * document, so callers keep the current page. A digits value is clamped into
 * `[1, pageCount]`. Rejecting everything else (letters, signs, decimals,
 * exponent and hex notation) means a fat-fingered entry reverts rather than
 * jumping somewhere unexpected.
 */
export function parsePageNumber(text: string, pageCount: number): number | null {
  if (pageCount <= 0) return null;
  const normalized = text.trim();
  if (!/^\d+$/.test(normalized)) return null;
  return clampPage(Number(normalized), pageCount);
}
