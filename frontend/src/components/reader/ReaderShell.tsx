import { useCallback, useRef, useState } from "react";
import { useAnnotations } from "@/hooks/useAnnotations";
import { useLibrary } from "@/hooks/useLibrary";
import { epubSurfaceTheme, readerChromeVariables } from "@/lib/epub/appearance";
import { highlightCss, readerThemeFamily } from "@/lib/highlightPalette";
import { cn } from "@/lib/utils";
import { useAppDispatch, useAppState } from "@/state/appState";
import { useReader, type ReaderTheme } from "@/state/readerState";
import type { Annotation } from "@/types/domain";
import {
  jumpToAnnotation as annotationJumpTarget,
  type ReaderAdapter,
  type ReaderPosition,
} from "./readerModel";
import { PDF_PLACEHOLDER_PAGE_COUNT } from "./placeholderDocument";
import type { PdfBookTurnAdapter } from "./pdf/pdfBookTurn";
import type { EpubTocItem } from "@/lib/epub/readiumEngine";
import type { PdfOutlineItem } from "@/lib/pdf/pdfEngine";
import { ReaderNavigation } from "./ReaderNavigation";
import { ReaderSearchOverlay } from "./ReaderSearchOverlay";
import { SelectionToolbar } from "./SelectionToolbar";
import { ReaderHeader } from "./shell/ReaderHeader";
import { ReaderProgressFooter } from "./shell/ReaderProgressFooter";
import { ReaderSurface } from "./shell/ReaderSurface";
import { ReaderOpeningHighlight, ReaderUnavailable } from "./shell/ReaderStates";
import {
  outlineForBook,
  positionForBook,
  presentationFlag,
  tocForBook,
} from "./shell/reportedData";
import { useBookModeShortcut } from "./shell/useBookModeShortcut";
import { useInitialJump } from "./shell/useInitialJump";
import { useMarkBookOpened } from "./shell/useMarkBookOpened";
import { useReaderBookmarks } from "./shell/useReaderBookmarks";
import { useReaderHighlights } from "./shell/useReaderHighlights";
import { useReaderPaging } from "./shell/useReaderPaging";
import { usePagingKeys } from "./shell/usePagingKeys";
import { useReaderPanelShortcuts, useReaderPanels } from "./shell/useReaderPanels";
import { useReaderPresentation } from "./shell/useReaderPresentation";
import { useReaderProgressSeek } from "./shell/useReaderProgressSeek";
import { useReaderSearch } from "./shell/useReaderSearch";
import { useAxisLockedWheel } from "./useAxisLockedWheel";

// Reader chrome classes per theme. Named presets paint their own chrome so
// the toolbar/drawer match the surface no matter what the app theme is
// (hexes mirror EPUB_THEME_COLORS; Tailwind needs static class strings).
// Only the neutral default follows the app tokens — publisher colors own
// the content and the app owns the chrome.
const THEME_CLASSES: Record<ReaderTheme, string> = {
  default: "bg-background text-foreground",
  light: "bg-[#ffffff] text-[#1f2328]",
  paper: "bg-[#f6f0e4] text-[#3a332a]",
  dark: "bg-zinc-950 text-zinc-100",
  // PDF-only explicit inversion (issue #67): the same chrome the dark
  // preset paints — the negative pages float over an equally dark surface.
  invert: "bg-zinc-950 text-zinc-100",
  contrast: "bg-black text-[#ffff00]",
  "blue-contrast": "bg-[#181842] text-white",
  "mint-contrast": "bg-[#c5e7cd] text-black",
};

/**
 * Full-window reading mode: no sidebar, its own visual language, and a
 * distinct visual language from the library. The shell owns the genuinely
 * shared reader concepts — current book, progress, navigation, bookmark
 * placement, in-book search state, and the selection toolbar — while the
 * open format reader (EPUB or PDF) registers its adapter (`readerModel`)
 * for jumps, search, and highlight creation. Position persistence lives in
 * the shared useReaderProgress contract; the format adapters keep their
 * own rendering models and engines.
 *
 * The pieces live in `shell/`: hooks own the stateful behavior and
 * components own the chrome, so nothing here grows into a second engine.
 */
export function ReaderShell() {
  const { selectedBookId, readerTargetAnnotationId } = useAppState();
  const { books } = useLibrary();
  const dispatch = useAppDispatch();
  const { preferences, position, setPosition, setPreferences } = useReader();

  const book = books.find((candidate) => candidate.id === selectedBookId) ?? null;
  const bookId = book?.id ?? -1;
  // Which reader draws this book is the format registry's decision; the
  // surface asks for it. The shell only needs the format checks it gates
  // chrome and shortcuts with.
  const isPdf = book?.format === "pdf";
  const isEpub = book?.format === "epub";

  const readerViewRef = useRef<HTMLDivElement | null>(null);
  // The reading scroll surface; PDF page tracking and PageUp/PageDown live here.
  const readerContentRef = useRef<HTMLElement | null>(null);
  // The open reader's adapter: how the shell jumps, searches, and creates
  // highlights without knowing which engine is underneath. Registered while
  // the reader's document is open, nulled on unmount/book switch.
  const adapterRef = useRef<ReaderAdapter | null>(null);
  // The open book view's turn adapter (tuxbooks-9pr.5): the keyboard's
  // book-mode keys call the same instance the view's edge/corner zones call.
  const bookTurnRef = useRef<PdfBookTurnAdapter | null>(null);
  useAxisLockedWheel(readerContentRef);

  // Navigation data reported by the open reader, tagged with its book id so a
  // stale book's TOC, outline, or position is never shown.
  const [epubTocState, setEpubTocState] = useState<{
    bookId: number;
    toc: EpubTocItem[];
  } | null>(null);
  const [pdfOutlineState, setPdfOutlineState] = useState<{
    bookId: number;
    outline: PdfOutlineItem[];
  } | null>(null);
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  const [reportedPosition, setReportedPosition] = useState<{
    bookId: number;
    position: ReaderPosition;
  } | null>(null);

  // Highlight swatches and painted washes resolve through the palette so a
  // theme-family flip or a Settings override restyles without touching the
  // annotations themselves (they persist slot keys).
  const highlightColorFor = useCallback(
    (color: string | null | undefined) =>
      highlightCss(color, readerThemeFamily(preferences.theme), preferences.highlightOverrides),
    [preferences.theme, preferences.highlightOverrides],
  );

  const annotationsApi = useAnnotations(book?.id ?? null);
  const { annotations } = annotationsApi;
  const epubToc = tocForBook(epubTocState, book?.id);
  const pdfOutline = outlineForBook(pdfOutlineState, book?.id);
  const activePosition = positionForBook(reportedPosition, book?.id);

  const panels = useReaderPanels();
  const presentation = useReaderPresentation({
    bookId,
    bookOpen: book !== null,
    readerViewRef,
  });
  const progress = useReaderProgressSeek({
    position,
    adapterRef,
  });

  // Every navigation entry point funnels through the open adapter: search
  // matches, annotations, TOC entries, outline entries, and pages all jump in
  // the document's own coordinates.
  const jump = useCallback((target: Parameters<ReaderAdapter["jump"]>[0]) => {
    adapterRef.current?.jump(target);
  }, []);
  const jumpToAnnotation = useCallback(
    (annotation: Annotation) => {
      const target = annotationJumpTarget(annotation);
      if (target) jump(target);
    },
    [jump],
  );

  const search = useReaderSearch({ bookId, adapterRef, jump });
  const paging = useReaderPaging({
    isPdf: Boolean(isPdf),
    presentation: presentation.presentation,
    bookMode: preferences.bookMode,
    position,
    setPosition,
    pdfPageCount,
    pdfPageCountPlaceholder: PDF_PLACEHOLDER_PAGE_COUNT,
    bookTurnRef,
  });
  usePagingKeys({
    isPdf: Boolean(isPdf),
    isEpub: Boolean(isEpub),
    presentation: presentation.presentation,
    bookMode: preferences.bookMode,
    paging,
    contentRef: readerContentRef,
  });
  useReaderPanelShortcuts({
    isEpub,
    appearanceOpen: panels.appearanceOpen,
    contentRef: readerContentRef,
    toggleNav: panels.toggleNav,
    setPdfSidebarOpen: panels.setPdfSidebarOpen,
    setAppearanceOpen: panels.setAppearanceOpen,
  });

  const bookmarks = useReaderBookmarks({ activePosition, annotationsApi, epubToc, isEpub });
  const highlights = useReaderHighlights({ bookId, annotationsApi, adapterRef });
  const { initialJump, waiting } = useInitialJump({
    targetId: readerTargetAnnotationId,
    annotations,
    loaded: annotationsApi.loaded,
    dispatch,
  });
  useMarkBookOpened(bookId);

  const toggleBookMode = useCallback(
    () => setPreferences({ bookMode: !preferences.bookMode }),
    [preferences.bookMode, setPreferences],
  );
  useBookModeShortcut({
    bookOpen: book !== null,
    presentation: presentation.presentation,
    toggleBookMode,
  });

  const openNav = () => panels.openNav(isEpub ? "contents" : "outline");

  if (!book) {
    return (
      <div
        data-testid="reader-view"
        className="flex h-screen flex-col items-center justify-center gap-3"
      >
        <ReaderUnavailable onBack={() => dispatch({ type: "return-to-library" })} />
      </div>
    );
  }

  // The initial highlight is read from the annotation list; wait for it so
  // the reader's first restore can land on the row the user clicked instead
  // of opening at the saved position first.
  if (waiting) {
    return (
      <div
        data-testid="reader-opening-highlight"
        className="flex h-screen items-center justify-center text-sm text-muted-foreground"
      >
        <ReaderOpeningHighlight />
      </div>
    );
  }

  return (
    <div
      ref={readerViewRef}
      data-testid="reader-view"
      data-theme={preferences.theme}
      data-reader-position={Math.round(position)}
      data-pdf-presentation={presentationFlag(isPdf, presentation.presentation)}
      data-epub-presentation={presentationFlag(isEpub, presentation.presentation)}
      className={cn(
        "relative flex h-screen flex-col overflow-hidden",
        THEME_CLASSES[preferences.theme],
      )}
      style={readerChromeVariables(epubSurfaceTheme(preferences.theme))}
    >
      <ReaderHeader
        book={book}
        isPdf={Boolean(isPdf)}
        isEpub={Boolean(isEpub)}
        theme={preferences.theme}
        bookMode={preferences.bookMode}
        presentation={presentation.presentation}
        pdfSidebarOpen={panels.pdfSidebarOpen}
        onTogglePdfSidebar={() => panels.setPdfSidebarOpen((open) => !open)}
        onPdfControlsHost={panels.setPdfControlsHost}
        onOpenNav={openNav}
        onOpenSearch={() => search.setSearchOpen(true)}
        onToggleBookMode={toggleBookMode}
        onTogglePresentation={presentation.togglePresentation}
        appearanceOpen={panels.appearanceOpen}
        onAppearanceOpenChange={panels.setAppearanceOpen}
        bookmarked={bookmarks.bookmarked}
        onToggleBookmark={() => void bookmarks.toggleBookmark()}
        labelTarget={bookmarks.labelTarget}
        onCloseLabel={bookmarks.closeLabelPopover}
        onCommitLabel={bookmarks.commitBookmarkLabel}
        onBack={() => dispatch({ type: "return-to-library" })}
      />

      <ReaderSurface
        book={book}
        presentation={presentation.presentation}
        pdfSidebarOpen={panels.pdfSidebarOpen}
        sidebarHost={panels.pdfSidebarHost}
        controlsHost={panels.pdfControlsHost}
        setSidebarHost={panels.setPdfSidebarHost}
        contentRef={readerContentRef}
        adapterRef={adapterRef}
        bookTurnRef={bookTurnRef}
        initialJump={initialJump}
        highlights={highlights.highlights}
        theme={preferences.theme}
        onTocLoad={(toc) => setEpubTocState({ bookId: book.id, toc })}
        onOutlineLoad={(outline) => setPdfOutlineState({ bookId: book.id, outline })}
        onDocumentLoad={setPdfPageCount}
        onPositionChange={(nextPosition) =>
          setReportedPosition({ bookId: book.id, position: nextPosition })
        }
        onSearchGroup={search.appendSearchGroupFrom}
        onSearchDone={search.finishSearchFrom}
        onCreateHighlight={highlights.handleCreateHighlight}
        onSelectionChange={(selection) => highlights.handleSelectionFrom(book.id, selection)}
        onExitPresentation={presentation.exitPresentation}
        onTogglePresentation={presentation.togglePresentation}
      />

      <ReaderProgressFooter
        presentation={presentation.presentation}
        isEpub={Boolean(isEpub)}
        position={position}
        progressPreview={progress.preview}
        onPreviewChange={progress.setPreview}
        onCommit={setPosition}
        label={progress.label}
        onLabelChange={progress.setLabel}
        onReadLabel={progress.readLabel}
        progressBarRef={progress.barRef}
        onReleaseFocus={progress.releaseFocus}
      />

      <ReaderNavigation
        open={panels.nav.open}
        onOpenChange={panels.setNavOpen}
        book={book}
        onJump={jump}
        epubToc={isEpub ? epubToc : null}
        pdfOutline={isPdf ? pdfOutline : null}
        annotations={annotations}
        onAnnotationJump={jumpToAnnotation}
        onDeleteAnnotation={(id) => void annotationsApi.remove(id)}
        onUpdateAnnotation={(id, patch) => void annotationsApi.update(id, patch)}
        tab={panels.nav.tab}
        onTabChange={panels.selectNavTab}
        colorFor={highlightColorFor}
        theme={preferences.theme}
      />

      <ReaderSearchOverlay
        open={search.searchOpen}
        onOpenChange={search.setSearchOpen}
        search={search.activeSearch}
        onSearch={search.runSearch}
        onPickMatch={search.pickSearchMatch}
        theme={preferences.theme}
      />

      <SelectionToolbar
        selection={highlights.activeSelection}
        onAction={highlights.handleHighlightAction}
        onDismiss={highlights.handleDismissSelection}
        colorFor={highlightColorFor}
      />
    </div>
  );
}
