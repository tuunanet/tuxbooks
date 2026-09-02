/**
 * PDF outline (document table of contents) normalization — no React, no
 * PDF.js imports. The raw engine outline is an untyped tree whose
 * destinations may be named ("chapter-2"), explicit arrays whose first
 * element is a page reference, or absent entirely (external-link entries).
 * This module resolves every destination to a stable 1-based page number,
 * the same locator the reader persists, so outline navigation shares the
 * position model instead of growing a second one.
 */

/** One outline entry with its destination resolved to a page. */
export interface PdfOutlineItem {
  title: string;
  /**
   * 1-based destination page, or null when the entry does not land on a
   * page (external URL, unresolvable/named-missing destination). Null
   * entries are displayed but not navigable.
   */
  page: number | null;
  items: PdfOutlineItem[];
}

/**
 * Structural surface of the engine document needed here; satisfied by the
 * PDF.js document proxy without importing it.
 */
export interface PdfOutlineSource {
  getOutline(): Promise<unknown>;
  getDestination(id: string): Promise<unknown>;
  getPageIndex(ref: unknown): Promise<number>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Resolves one raw destination (named string or explicit array) to a 1-based page. */
async function resolveDestPage(dest: unknown, document: PdfOutlineSource): Promise<number | null> {
  try {
    let explicit = dest;
    if (typeof dest === "string") {
      explicit = await document.getDestination(dest);
    }
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const ref = explicit[0];
    if (!isRecord(ref)) return null;
    const index = await document.getPageIndex(ref);
    return Number.isInteger(index) && index >= 0 ? index + 1 : null;
  } catch {
    // An entry that cannot be resolved is a display-only outline row,
    // never a reader error.
    return null;
  }
}

async function convertItem(
  raw: unknown,
  document: PdfOutlineSource,
): Promise<PdfOutlineItem | null> {
  if (!isRecord(raw)) return null;
  const page = await resolveDestPage(raw.dest, document);
  const children = Array.isArray(raw.items)
    ? (await Promise.all(raw.items.map((child) => convertItem(child, document)))).filter(
        (item): item is PdfOutlineItem => item !== null,
      )
    : [];
  return {
    title: typeof raw.title === "string" ? raw.title : "",
    page,
    items: children,
  };
}

/**
 * Normalizes the engine's outline tree. Documents without an outline
 * normalize to an empty list; malformed entries are skipped or rendered
 * inert instead of failing the load.
 */
export async function normalizePdfOutline(document: PdfOutlineSource): Promise<PdfOutlineItem[]> {
  const outline = await document.getOutline();
  if (!Array.isArray(outline)) return [];
  const items = await Promise.all(outline.map((entry) => convertItem(entry, document)));
  return items.filter((item): item is PdfOutlineItem => item !== null);
}
