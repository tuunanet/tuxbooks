import type { RefObject } from "react";
import { readerScrollbarColor, epubSurfaceTheme } from "@/lib/epub/appearance";
import { FORMATS } from "@/lib/formats";
import type { ReaderTheme } from "@/state/readerState";
import type { Annotation, AnnotationInput, Book } from "@/types/domain";
import type { EpubTocItem } from "@/lib/epub/readiumEngine";
import type { PdfOutlineItem } from "@/lib/pdf/pdfEngine";
import { EpubReader } from "../EpubReader";
import { PdfReader } from "../pdf/PdfReader";
import type { PdfBookTurnAdapter } from "../pdf/pdfBookTurn";
import type { ReaderAdapter, ReaderJump, ReaderPosition } from "../readerModel";
import type { ReaderSelection } from "../annotationModel";

interface ReaderSurfaceProps {
  book: Book;
  presentation: boolean;
  pdfSidebarOpen: boolean;
  sidebarHost: HTMLElement | null;
  controlsHost: HTMLElement | null;
  setSidebarHost: (el: HTMLElement | null) => void;
  contentRef: RefObject<HTMLElement | null>;
  adapterRef: RefObject<ReaderAdapter | null>;
  bookTurnRef: RefObject<PdfBookTurnAdapter | null>;
  initialJump: ReaderJump | null;
  highlights: Annotation[];
  theme: ReaderTheme;
  onTocLoad: (toc: EpubTocItem[]) => void;
  onOutlineLoad: (outline: PdfOutlineItem[]) => void;
  onDocumentLoad: (pageCount: number) => void;
  onPositionChange: (position: ReaderPosition) => void;
  onSearchGroup: (id: number, group: import("../searchModel").ReaderSearchGroup) => void;
  onSearchDone: (id: number, truncated: boolean) => void;
  onCreateHighlight: (input: AnnotationInput) => void;
  onSelectionChange: (selection: ReaderSelection | null) => void;
  onExitPresentation: () => void;
  onTogglePresentation: () => void;
}

/**
 * The document area: the PDF thumbnails slot, the scroll surface, and the
 * engine the format registry names. A format with no known engine renders
 * nothing rather than silently becoming a PDF.
 */
export function ReaderSurface({
  book,
  presentation,
  pdfSidebarOpen,
  sidebarHost,
  controlsHost,
  setSidebarHost,
  contentRef,
  adapterRef,
  bookTurnRef,
  initialJump,
  highlights,
  theme,
  onTocLoad,
  onOutlineLoad,
  onDocumentLoad,
  onPositionChange,
  onSearchGroup,
  onSearchDone,
  onCreateHighlight,
  onSelectionChange,
  onExitPresentation,
  onTogglePresentation,
}: ReaderSurfaceProps) {
  const engine = FORMATS[book.format].engine;
  const isPdf = book.format === "pdf";
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {isPdf && pdfSidebarOpen && !presentation && (
        <aside
          ref={setSidebarHost}
          data-testid="pdf-sidebar"
          aria-label="Page thumbnails"
          className="h-full w-44 shrink-0 overflow-hidden border-r"
        />
      )}
      <main
        ref={contentRef}
        data-testid="reader-content"
        // Programmatic focus target for panel shortcuts: keeps focus on the
        // reading surface so the nav drawer's focus guard does not grab it
        // when its async contents load.
        tabIndex={-1}
        aria-label="Reading view"
        // overflow-anchor off: Chromium's scroll anchoring adjusts scrollTop
        // when the PDF virtualizer corrects slot heights above the viewport,
        // double-compensating against pdfLayout's own scroll compensation, so
        // long jumps never converge (WebKit has no scroll anchoring, which is
        // why this only bites on Electron). scrollbar-gutter stable:
        // Chromium's classic scrollbars take real width, so without it the
        // fit-width scale recomputes twice and every fit-scale change
        // re-anchors the viewport, landing long jumps on the wrong page.
        className="min-h-0 flex-1 overflow-auto [overflow-anchor:none] [scrollbar-gutter:stable] [scrollbar-color:var(--reader-scrollbar-thumb,auto)]"
        style={
          {
            "--reader-scrollbar-thumb": readerScrollbarColor(epubSurfaceTheme(theme)),
          } as React.CSSProperties
        }
      >
        {engine === "readium" ? (
          <EpubReader
            key={book.id}
            book={book}
            onTocLoad={onTocLoad}
            onPositionChange={onPositionChange}
            adapterRef={adapterRef}
            initialJump={initialJump}
            onSearchGroup={onSearchGroup}
            onSearchDone={onSearchDone}
            highlights={highlights}
            onCreateHighlight={onCreateHighlight}
            onSelectionChange={onSelectionChange}
            presentationMode={presentation}
            onExitPresentation={onExitPresentation}
          />
        ) : engine === "pdfium" ? (
          <PdfReader
            key={book.id}
            book={book}
            onDocumentLoad={onDocumentLoad}
            onOutlineLoad={onOutlineLoad}
            sidebarHost={sidebarHost}
            controlsHost={controlsHost}
            scrollContainerRef={contentRef}
            onPositionChange={onPositionChange}
            adapterRef={adapterRef}
            initialJump={initialJump}
            onSearchGroup={onSearchGroup}
            onSearchDone={onSearchDone}
            highlights={highlights}
            presentationMode={presentation}
            onExitPresentation={onExitPresentation}
            onTogglePresentation={onTogglePresentation}
            onCreateHighlight={onCreateHighlight}
            onSelectionChange={onSelectionChange}
            bookTurnRef={bookTurnRef}
          />
        ) : null}
      </main>
    </div>
  );
}
