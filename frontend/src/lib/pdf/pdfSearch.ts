/**
 * Pure PDF text-search matching, unit-testable without PDF.js. The engine
 * seam (`lib/pdf/pdfEngine.ts`) extracts a page's text items; this module
 * assembles them into searchable text and finds matches with excerpts.
 */

/** Structural subset of PDF.js text content items the assembler needs. */
export interface PdfTextItem {
  str: string;
  hasEOL: boolean;
}

export interface PdfSearchExcerpt {
  pre: string;
  match: string;
  post: string;
}

/**
 * Assembles a page's text items into one plain string. Line breaks and item
 * boundaries become single spaces (PDF text items split arbitrarily), so
 * queries match across item and line boundaries just like in the rendered
 * text.
 */
export function assemblePageText(items: readonly PdfTextItem[]): string {
  let text = "";
  for (const item of items) {
    text += item.str;
    if (item.hasEOL || !item.str.endsWith(" ")) text += " ";
  }
  return text.replace(/\s+/g, " ").trimStart().trimEnd();
}

/**
 * Finds every case-insensitive occurrence of `query` in `pageText`,
 * returning excerpts with `contextChars` of surrounding text on each side.
 * Positions are returned in reading order.
 */
export function findPageMatches(
  pageText: string,
  query: string,
  contextChars = 40,
): PdfSearchExcerpt[] {
  const haystack = pageText.toLowerCase();
  const needle = query.toLowerCase();
  if (needle.length === 0) return [];
  const excerpts: PdfSearchExcerpt[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    excerpts.push({
      pre: pageText.slice(Math.max(0, index - contextChars), index),
      match: pageText.slice(index, index + needle.length),
      post: pageText.slice(index + needle.length, index + needle.length + contextChars),
    });
    index = haystack.indexOf(needle, index + needle.length);
  }
  return excerpts;
}
