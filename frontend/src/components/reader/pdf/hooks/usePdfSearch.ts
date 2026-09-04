import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  findPageMatches,
  getPdfPageText,
  type PdfDocument,
  type PdfSearchExcerpt,
} from "@/lib/pdf/pdfEngine";
import type { ReaderSearchController, ReaderSearchGroup } from "../../searchModel";

/** Stop searching after this many matches; pathological documents must
 * not flood the results list (or the DOM) forever. */
const MAX_TOTAL_MATCHES = 500;

interface UsePdfSearchOptions {
  document: PdfDocument | null;
  bookId: number;
  onGroup: (bookId: number, group: ReaderSearchGroup) => void;
  onDone: (bookId: number) => void;
}

/**
 * In-book search for the PDF reader: extracts each page's text through the
 * engine seam (`getPdfPageText`), matches it with the pure pdfSearch
 * helpers, and streams one group per page with matches up to the shell.
 *
 * Pages are extracted sequentially (PDF.js serializes work in the worker
 * anyway) and each page's text is cached for the document's lifetime, so a
 * refined query re-searches without re-parsing. A new query supersedes the
 * running one via a generation token; `cancel()` does the same on demand.
 */
export function usePdfSearch({
  document: pdfDocument,
  bookId,
  onGroup,
  onDone,
}: UsePdfSearchOptions): ReaderSearchController {
  const generationRef = useRef(0);
  const onGroupRef = useRef(onGroup);
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onGroupRef.current = onGroup;
    onDoneRef.current = onDone;
  });

  // Per-document page text cache; dropped when the document instance
  // changes (book switch), never shared across documents. The reset happens
  // inside `run`, never during render.
  const cacheRef = useRef<{ document: PdfDocument | null; pages: Map<number, string> }>({
    document: null,
    pages: new Map(),
  });

  const run = useCallback(
    (query: string) => {
      if (!pdfDocument || query === "") return;
      const generation = ++generationRef.current;
      if (cacheRef.current.document !== pdfDocument) {
        cacheRef.current = { document: pdfDocument, pages: new Map() };
      }
      const cache = cacheRef.current;

      const pageText = async (pageNumber: number): Promise<string> => {
        const cached = cache.pages.get(pageNumber);
        if (cached !== undefined) return cached;
        const text = await getPdfPageText(pdfDocument, pageNumber);
        cache.pages.set(pageNumber, text);
        return text;
      };

      void (async () => {
        let totalMatches = 0;
        for (let page = 1; page <= pdfDocument.numPages; page++) {
          if (generation !== generationRef.current) return;
          let text = "";
          try {
            text = await pageText(page);
          } catch (error) {
            // An unreadable page has no search results; the document
            // search continues.
            console.warn(`PDF text extraction failed for page ${page}`, error);
            continue;
          }
          if (generation !== generationRef.current) return;
          const excerpts: PdfSearchExcerpt[] = findPageMatches(text, query);
          if (excerpts.length > 0) {
            totalMatches += excerpts.length;
            onGroupRef.current?.(bookId, {
              label: `Page ${page}`,
              matches: excerpts.map((excerpt) => ({ cfi: null, page, excerpt })),
            });
          }
          if (totalMatches >= MAX_TOTAL_MATCHES) break;
        }
        if (generation === generationRef.current) onDoneRef.current?.(bookId);
      })();
    },
    [pdfDocument, bookId],
  );

  const cancel = useCallback(() => {
    generationRef.current += 1;
  }, []);

  return useMemo(() => ({ run, cancel }), [run, cancel]);
}
