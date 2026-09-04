/**
 * Splits an FTS5 snippet at its `<em>` / `</em>` match markers into
 * before / match / after text for styled rendering. Returns null when the
 * snippet carries no complete marker pair, in which case callers render
 * the raw snippet text instead.
 */
export function splitSnippet(snippet: string): { pre: string; match: string; post: string } | null {
  const start = snippet.indexOf("<em>");
  const end = snippet.lastIndexOf("</em>");
  if (start === -1 || end === -1 || end < start) return null;
  return {
    pre: snippet.slice(0, start),
    match: snippet.slice(start + 4, end),
    post: snippet.slice(end + 5),
  };
}
