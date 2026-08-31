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
