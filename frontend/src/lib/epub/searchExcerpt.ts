/** Surrounding text around one EPUB search match. */
export interface EpubSearchExcerpt {
  pre: string;
  match: string;
  post: string;
}

/**
 * The context around one match inside a single text node. Whitespace at the
 * match boundary is part of the reading context, so only the outer edges of
 * the excerpt are trimmed: a space before or after the match must survive or
 * the rendered row reads "architecturematters". Runs of whitespace collapse
 * to one space so line breaks do not turn into gaps.
 */
export function excerptAround(
  text: string,
  at: number,
  length: number,
  context = 48,
): EpubSearchExcerpt {
  return {
    pre: text
      .slice(Math.max(0, at - context), at)
      .replace(/\s+/g, " ")
      .trimStart(),
    match: text.slice(at, at + length),
    post: text
      .slice(at + length, at + length + context)
      .replace(/\s+/g, " ")
      .trimEnd(),
  };
}
