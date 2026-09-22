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

/**
 * Parse a typed page number for a document with `pageCount` pages. Returns
 * null for empty, non-numeric, or non-finite input, and for an empty document,
 * so callers keep the current page. A numeric value is truncated to a whole
 * page and clamped into `[1, pageCount]`.
 */
export function parsePageNumber(text: string, pageCount: number): number | null {
  if (pageCount <= 0) return null;
  const normalized = text.trim();
  if (normalized === "") return null;
  const value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  return Math.min(pageCount, Math.max(1, Math.trunc(value)));
}
