/**
 * PDF outline (document table of contents) normalization — no React, no
 * engine imports. The engine's raw outline is a tree whose entries carry a
 * resolved 0-based page for internal destinations and no page for external
 * links. This module converts every entry to the app's stable 1-based page
 * locator, the same locator the reader persists, so outline navigation
 * shares the position model instead of growing a second one.
 */

/** One outline entry with its destination resolved to a page. */
export interface PdfOutlineItem {
  title: string;
  /**
   * 1-based destination page, or null when the entry does not land on a
   * page (external URL, unresolvable destination). Null entries are
   * displayed but not navigable.
   */
  page: number | null;
  items: PdfOutlineItem[];
}

/** Raw engine outline entry (0-based page, as MuPDF resolves destinations). */
export interface RawPdfOutline {
  title?: string;
  /** 0-based page number, or null/undefined when the entry has no page. */
  page?: number | null;
  items?: RawPdfOutline[];
}

/**
 * Normalizes the engine's raw outline tree to 1-based pages. Documents
 * without an outline normalize to an empty list; malformed entries are
 * skipped or rendered inert instead of failing the load.
 */
export function normalizePdfOutline(raw: RawPdfOutline[] | null | undefined): PdfOutlineItem[] {
  if (!Array.isArray(raw)) return [];
  const items: PdfOutlineItem[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    items.push({
      title: typeof entry.title === "string" ? entry.title : "",
      page: typeof entry.page === "number" && entry.page >= 0 ? entry.page + 1 : null,
      items: normalizePdfOutline(entry.items),
    });
  }
  return items;
}
