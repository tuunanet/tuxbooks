import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bookmark,
  BookmarkCheck,
  PanelLeft,
  Presentation,
  Search,
  TableOfContents,
} from "lucide-react";
import { Slider as SliderPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { Popover, PopoverAnchor } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useShortcut } from "@/lib/shortcuts";
import {
  formatShortcutAria,
  formatShortcutDisplay,
  READER_PANEL_SHORTCUTS,
  READER_SEARCH_SHORTCUTS,
} from "@/lib/readerShortcuts";
import { markBookOpened } from "@/lib/bridge";
import { cn } from "@/lib/utils";
import { useAnnotations } from "@/hooks/useAnnotations";
import { useLibrary } from "@/hooks/useLibrary";
import { useAppDispatch, useAppState } from "@/state/appState";
import { useReader, type ReaderTheme } from "@/state/readerState";
import {
  epubSurfaceTheme,
  readerChromeVariables,
  readerScrollbarColor,
} from "@/lib/epub/appearance";
import { byKind, type HighlightAction, type ReaderSelection } from "./annotationModel";
import { highlightCss, readerThemeFamily } from "@/lib/highlightPalette";
import { bookmarkLocationAndProgress } from "@/lib/annotationLocation";
import {
  bookmarkBaseLabel,
  bookmarkInputFor,
  isBookmarkAtPosition,
  jumpToAnnotation as annotationJumpTarget,
  jumpToSearchMatch,
  locationLabel,
  type ReaderAdapter,
  type ReaderJump,
  type ReaderPosition,
} from "./readerModel";
import { PDF_PLACEHOLDER_PAGE_COUNT } from "./placeholderDocument";
import { pageToPosition, positionToPage } from "./pdf/pdfPages";
import type { EpubTocItem } from "@/lib/epub/readiumEngine";
import type { PdfOutlineItem } from "@/lib/pdf/pdfEngine";
import type { Annotation, AnnotationInput } from "@/types/domain";
import { EpubReader } from "./EpubReader";
import { PdfReader } from "./pdf/PdfReader";
import { BookmarkLabelPopover } from "./BookmarkLabelPopover";
import { ReaderNavigation, type ReaderNavTab } from "./ReaderNavigation";
import { ReaderSearchOverlay } from "./ReaderSearchOverlay";
import { ReaderAppearance } from "./ReaderAppearance";
import { SelectionToolbar } from "./SelectionToolbar";
import { useAxisLockedWheel } from "./useAxisLockedWheel";
import {
  appendSearchGroup,
  emptySearchState,
  finishSearchGroup,
  type ReaderSearchGroup,
  type ReaderSearchMatch,
  type ReaderSearchState,
} from "./searchModel";

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
 */
export function ReaderShell() {
  const { selectedBookId, readerTargetAnnotationId } = useAppState();
  const { books } = useLibrary();
  const dispatch = useAppDispatch();
  const { preferences, position, setPosition } = useReader();
  // Highlight swatches and painted washes resolve through the palette so a
  // theme-family flip or a Settings override restyles without touching the
  // annotations themselves (they persist slot keys).
  const highlightColorFor = useCallback(
    (color: string | null | undefined) =>
      highlightCss(color, readerThemeFamily(preferences.theme), preferences.highlightOverrides),
    [preferences.theme, preferences.highlightOverrides],
  );
  // The navigation drawer plus its selected tab. In-book search is a
  // separate overlay (below), not a drawer tab.
  const [nav, setNav] = useState<{ open: boolean; tab: ReaderNavTab }>({
    open: false,
    tab: "contents",
  });
  const openNav = (tab: ReaderNavTab) => setNav({ open: true, tab });
  // Spotlight-style in-book search. The query and results live in
  // `searchState` below, so closing the overlay never discards them.
  const [searchOpen, setSearchOpen] = useState(false);
  // Drawer shortcut behavior: any drawer key closes the drawer whatever tab
  // is showing and never switches tabs while it is open; otherwise it opens
  // straight onto the requested tab.
  const toggleNav = (tab: ReaderNavTab) =>
    setNav((prev) => (prev.open ? { ...prev, open: false } : { open: true, tab }));
  // Real PDF page count, reported by PdfReader once the document loads.
  const [pdfPageCount, setPdfPageCount] = useState<number | null>(null);
  // Real EPUB table of contents, reported by EpubReader once the engine
  // opens the book; EPUB navigation goes through the engine's destinations.
  // Kept with its owning book id so a stale book's TOC is never shown —
  // the derived value resets without a setState-in-effect.
  const [epubTocState, setEpubTocState] = useState<{
    bookId: number;
    toc: EpubTocItem[];
  } | null>(null);
  // Real PDF outline, reported by PdfReader once the engine resolves it.
  // Kept with its owning book id so a stale book's outline is never shown.
  const [pdfOutlineState, setPdfOutlineState] = useState<{
    bookId: number;
    outline: PdfOutlineItem[];
  } | null>(null);
  // The open reader's adapter: how the shell jumps, searches, and creates
  // highlights without knowing which engine is underneath. Registered while
  // the reader's document is open, nulled on unmount/book switch.
  const adapterRef = useRef<ReaderAdapter | null>(null);
  // The open reader's latest position (EPUB CFI / PDF page), tagged with
  // its book id for the same staleness guard. Written through the unified
  // onPositionChange callback; relocates already re-render the shell, so
  // keeping this in state costs nothing extra and keeps `bookmarked`
  // render-honest.
  const [reportedPosition, setReportedPosition] = useState<{
    bookId: number;
    position: ReaderPosition;
  } | null>(null);
  // Streaming in-book search results for the open book (shared model for
  // both formats; stale books' results are ignored by the model helpers).
  const [searchState, setSearchState] = useState<ReaderSearchState | null>(null);
  // PDF thumbnails sidebar: the shell owns the docked host and the toggle;
  // PdfReader fills the host through a portal (it owns the document handle).
  const [pdfSidebarOpen, setPdfSidebarOpen] = useState(false);
  const [pdfSidebarHost, setPdfSidebarHost] = useState<HTMLElement | null>(null);
  // Appearance popover visibility: the shell owns the state so Ctrl+Shift+A
  // can toggle the otherwise-uncontrolled ReaderAppearance popover.
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  // PDF page/zoom controls dock into this header slot through the same
  // portal pattern: the reader keeps owning the zoom and position state,
  // the shell only provides the layout host (issue #68 — one compact
  // header row, no separate control bar above the document).
  const [pdfControlsHost, setPdfControlsHost] = useState<HTMLElement | null>(null);
  // Presentation mode (issues #65 PDF / #64 EPUB): the shell owns the toggle
  // (Ctrl+L), the chrome hiding (header, footer, thumbnails sidebar), and
  // the fullscreen request; the open reader owns the format-specific
  // rescale/layout (PDF fit modes, EPUB none — the engine reflows) and the
  // floating in-mode bar. Presentation always ends with the book — a book
  // switch must never carry the mode (and its hidden chrome) into the next.
  const [presentation, setPresentation] = useState(false);
  // Whether the fullscreen request actually succeeded: Esc leaves real
  // fullscreen natively, and the fullscreenchange listener then ends the
  // mode — but a denied/unavailable request (jsdom, kiosk shells) must not
  // tear the mode down on the next event. State, not a ref: the book-switch
  // reset runs as a render-phase adjustment, where refs are off-limits.
  const [fullscreenEntered, setFullscreenEntered] = useState(false);
  const readerViewRef = useRef<HTMLDivElement | null>(null);
  // The reading scroll surface; PDF page tracking and PageUp/PageDown live here.
  const readerContentRef = useRef<HTMLElement | null>(null);
  // The progress footer's seek bar; its pointer release hands focus back to
  // the reading surface (see the bar's onPointerUp).
  const progressBarRef = useRef<HTMLDivElement | null>(null);
  // Keep a wheel gesture on the axis it began on: releasing Shift while a
  // free-spinning wheel is still going must not flip horizontal scrolling to
  // vertical (see useAxisLockedWheel).
  useAxisLockedWheel(readerContentRef);

  const book = books.find((candidate) => candidate.id === selectedBookId) ?? null;
  const isPdf = book?.format === "pdf";
  const isEpub = book?.format === "epub";
  // While the pointer drags the footer's slider, the thumb and percent show
  // this preview; only the release commit navigates the engine — one jump
  // per gesture (the preview is presentation, not position).
  const [progressPreview, setProgressPreview] = useState<number | null>(null);
  // While you hover or drag the bar it shows the Kindle-style positioning
  // label ("Location N of M • P%"); leaving the bar clears it. The adapter
  // query runs inside the pointer handlers — refs stay out of render — and
  // a null open adapter degrades the label to percent-only.
  const [barPositioningLabel, setBarPositioningLabel] = useState<string | null>(null);
  const readPositioningLabel = (percent: number) => {
    const location = adapterRef.current?.progressionIndexFor?.(percent / 100) ?? null;
    setBarPositioningLabel(locationLabel(location, percent));
  };
  // Persistent annotations of the open book: bookmarks, highlights, notes.
  const {
    annotations,
    loaded: annotationsLoaded,
    create,
    remove,
    update,
  } = useAnnotations(book?.id ?? null);
  const epubToc =
    epubTocState !== null && epubTocState.bookId === book?.id ? epubTocState.toc : null;
  const pdfOutline =
    pdfOutlineState !== null && pdfOutlineState.bookId === book?.id
      ? pdfOutlineState.outline
      : null;
  const pageCount = isPdf ? (pdfPageCount ?? PDF_PLACEHOLDER_PAGE_COUNT) : 0;
  // Percentage stepping is only meaningful with a known page count; the
  // EPUB surface owns these keys instead (engine page turns).
  const step = pageCount > 0 ? 100 / pageCount : 0;

  useShortcut("home", () => setPosition(0));
  useShortcut("end", () => setPosition(100));
  // Arrow/space stepping and PageUp/PageDown scrolling are PDF behaviors:
  // they are not registered while an EPUB is open, where EpubReader owns
  // those combos outright (engine page turns) regardless of registration
  // order — a shell percentage step with no page count would clamp straight
  // to the beginning or end of the document.
  // PDF steps are page-based (issue #65): percentage stepping accumulates
  // rounding error (66.67% maps back onto page 2), so a page flip always
  // lands on the adjacent page. Without a known page count the percentage
  // step remains the fallback.
  const flipPdfPage = useCallback(
    (delta: 1 | -1) => {
      const count = pdfPageCount ?? 0;
      if (count <= 0) {
        setPosition(position + delta * step);
        return;
      }
      const page = positionToPage(position, count);
      const next = Math.max(1, Math.min(count, page + delta));
      setPosition(pageToPosition(next, count));
    },
    [pdfPageCount, position, setPosition, step],
  );
  const pdfPageStep = useCallback(
    (delta: 1 | -1) => {
      if (isPdf) flipPdfPage(delta);
      else setPosition(position + delta * step);
    },
    [flipPdfPage, isPdf, position, setPosition, step],
  );
  useShortcut(isEpub ? null : "arrowright", () => pdfPageStep(1));
  useShortcut(isEpub ? null : "space", () => pdfPageStep(1));
  useShortcut(isEpub ? null : "arrowleft", () => pdfPageStep(-1));
  useShortcut(isEpub ? null : "pagedown", () => {
    // Presentation mode turns the scroll-steppers into full page flips
    // (§ issue #65): one page fills the viewport, so partial-viewport
    // scrolling would land mid-page.
    if (isPdf && presentation) {
      flipPdfPage(1);
      return;
    }
    const container = readerContentRef.current;
    if (container) container.scrollTop += container.clientHeight * 0.9;
  });
  useShortcut(isEpub ? null : "pageup", () => {
    if (isPdf && presentation) {
      flipPdfPage(-1);
      return;
    }
    const container = readerContentRef.current;
    if (container) container.scrollTop -= container.clientHeight * 0.9;
  });
  useShortcut(isPdf && presentation ? "shift+space" : null, () => flipPdfPage(-1));
  // Ctrl/Cmd+F toggles the overlay, so a second press closes it without
  // reaching for the mouse.
  const toggleSearch = useCallback(() => setSearchOpen((open) => !open), []);
  useShortcut(READER_SEARCH_SHORTCUTS.primary, toggleSearch);

  // Panel shortcuts: thumbnails is a PDF affordance (the same `isEpub ? null`
  // gate as the page-turn combos), while the appearance popover and the
  // navigation drawer exist in both formats. The drawer keys toggle — a
  // second press closes the drawer instead of switching its tab.
  const focusReadingSurface = () => {
    // Only claim focus when nothing owns it. A shortcut fired from the EPUB
    // content frame (activeElement is the iframe) or a toolbar button must
    // keep that focus; focus left on body, by contrast, lets the drawer's
    // modal focus guard grab it when async contents land.
    if (document.activeElement === document.body) {
      readerContentRef.current?.focus({ preventScroll: true });
    }
  };
  useShortcut(isEpub ? null : READER_PANEL_SHORTCUTS.thumbnails, () =>
    setPdfSidebarOpen((open) => !open),
  );
  useShortcut(READER_PANEL_SHORTCUTS.appearance, () => setAppearanceOpen((open) => !open));
  // The EPUB navigator's capture-phase host listener intercepts Escape while
  // the reading frame owns focus, so Radix's popover never sees the key.
  // Close the controlled appearance popover through the same registry that
  // receives the forwarded key.
  useShortcut(appearanceOpen ? "escape" : null, () => setAppearanceOpen(false));
  useShortcut(READER_PANEL_SHORTCUTS.contents, () => {
    focusReadingSurface();
    toggleNav(isEpub ? "contents" : "outline");
  });
  useShortcut(READER_PANEL_SHORTCUTS.bookmarks, () => {
    focusReadingSurface();
    toggleNav("bookmarks");
  });
  useShortcut(READER_PANEL_SHORTCUTS.highlights, () => {
    focusReadingSurface();
    toggleNav("highlights");
  });

  // Presentation mode (issues #65 PDF / #64 EPUB): Ctrl+L toggles, Esc
  // exits, and a native fullscreen exit (Esc while really fullscreen) ends
  // the mode through fullscreenchange. The fullscreen request is
  // best-effort — a denied request still gives the distraction-free layout,
  // just inside the normal window.
  const exitPresentation = useCallback(() => {
    setPresentation(false);
    if (fullscreenEntered && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
    setFullscreenEntered(false);
  }, [fullscreenEntered]);
  const togglePresentation = useCallback(() => {
    if (presentation) {
      exitPresentation();
      return;
    }
    const surface = readerViewRef.current;
    const request = surface?.requestFullscreen?.bind(surface);
    if (request) {
      request()
        .then(() => {
          setFullscreenEntered(true);
        })
        .catch(() => {});
    }
    setPresentation(true);
  }, [exitPresentation, presentation]);
  useShortcut(book !== null ? "mod+l" : null, togglePresentation);
  useShortcut(presentation ? "escape" : null, exitPresentation);
  useEffect(() => {
    if (!presentation) return;
    const onFullscreenChange = () => {
      if (fullscreenEntered && !document.fullscreenElement) {
        setFullscreenEntered(false);
        setPresentation(false);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [presentation, fullscreenEntered]);

  // In-book search: the shell owns the state (one book open at a time), the
  // open reader's adapter streams matches in through the shared model
  // helpers, which ignore anything not belonging to the book being searched.
  const bookId = book?.id ?? -1;
  // End presentation mode when the open book changes (also covers the
  // return-to-library path — the mode never outlives its book). Render-
  // phase adjustment keyed on the book: the reset lands in the same render
  // pass as the switch, never as a setState-in-effect cascade.
  const [presentationBookId, setPresentationBookId] = useState(bookId);
  if (presentationBookId !== bookId) {
    setPresentationBookId(bookId);
    setPresentation(false);
    setFullscreenEntered(false);
  }
  // A search overlay never outlives its book: the next book starts with the
  // overlay closed and its own (empty) query.
  const [searchBookId, setSearchBookId] = useState(bookId);
  if (searchBookId !== bookId) {
    setSearchBookId(bookId);
    setSearchOpen(false);
  }
  // Reading session lifecycle: stamp `last_opened_at` once per open so the
  // "Recently read" section and the detail view's "Last opened" reflect this
  // session even if the reader closes without a position save. Best-effort —
  // a failed stamp must not block reading.
  useEffect(() => {
    if (bookId === -1) return;
    void markBookOpened(bookId).catch(() => {});
  }, [bookId]);
  const runSearch = useCallback(
    (query: string) => {
      if (query === "") {
        adapterRef.current?.search.cancel();
        setSearchState(null);
        return;
      }
      setSearchState(emptySearchState(bookId, query));
      adapterRef.current?.search.run(query);
    },
    [bookId],
  );
  const appendSearchGroupFrom = useCallback((id: number, group: ReaderSearchGroup) => {
    setSearchState((prev) => (prev ? appendSearchGroup(prev, id, group) : prev));
  }, []);
  const finishSearchFrom = useCallback((id: number, truncated: boolean) => {
    setSearchState((prev) => (prev ? finishSearchGroup(prev, id, truncated) : prev));
  }, []);
  // Every navigation entry point funnels through the open adapter: search
  // matches, annotations, TOC entries, outline entries, and pages all jump
  // in the document's own coordinates.
  const jump = useCallback((target: ReaderJump) => {
    adapterRef.current?.jump(target);
  }, []);
  const pickSearchMatch = useCallback(
    (match: ReaderSearchMatch) => {
      const target = jumpToSearchMatch(match);
      if (target) jump(target);
    },
    [jump],
  );
  const jumpToAnnotation = useCallback(
    (annotation: Annotation) => {
      const target = annotationJumpTarget(annotation);
      if (target) jump(target);
    },
    [jump],
  );

  // A highlight opened from the book detail view becomes the reader's
  // initial destination: the readers apply it as part of their restore, so
  // the initial scroll sample cannot read it back as the saved page.
  const targetAnnotation =
    readerTargetAnnotationId == null
      ? null
      : (annotations.find((annotation) => annotation.id === readerTargetAnnotationId) ?? null);
  const initialJump = targetAnnotation === null ? null : annotationJumpTarget(targetAnnotation);

  // The target is single-use: readers capture it at mount (as part of their
  // restore), so the shell drops it once the annotation list resolved.
  useEffect(() => {
    if (readerTargetAnnotationId != null && annotationsLoaded) {
      dispatch({ type: "reader-target-consumed" });
    }
  }, [readerTargetAnnotationId, annotationsLoaded, dispatch]);

  // Selection toolbar state, tagged with the book whose reader reported it
  // (readers remount per book, so a stale book can never write here). The
  // report carries the existing highlight the selection or click targets,
  // which flips the toolbar from creating to editing.
  const [selection, setSelection] = useState<(ReaderSelection & { bookId: number }) | null>(null);
  const activeSelection = useMemo(
    () =>
      selection !== null && selection.bookId === book?.id
        ? { text: selection.text, highlightId: selection.highlightId }
        : null,
    [selection, book?.id],
  );

  const activePosition =
    reportedPosition !== null && reportedPosition.bookId === book?.id
      ? reportedPosition.position
      : null;

  // Bookmarks: toggle at the exact current position (EPUB CFI / PDF page),
  // so the button also removes a bookmark placed on the same spot. Creating
  // one opens the label popover, which always binds to the newest bookmark;
  // the busy flag swallows presses while a create/remove round-trips, so a
  // double-press cannot make two bookmarks.
  const [labelTarget, setLabelTarget] = useState<{
    bookmark: Annotation;
    hint: string;
  } | null>(null);
  const bookmarkBusyRef = useRef(false);
  const toggleBookmark = useCallback(async () => {
    if (!activePosition || bookmarkBusyRef.current) return;
    const existing = annotations.find((annotation) =>
      isBookmarkAtPosition(annotation, activePosition),
    );
    bookmarkBusyRef.current = true;
    try {
      if (existing) {
        // Removing closes the popover; its half-typed draft goes with the
        // bookmark it belonged to.
        setLabelTarget(null);
        await remove(existing.id);
        return;
      }
      const created = await create(bookmarkInputFor(activePosition));
      // A failed create stays silent (console-only), and no popover opens.
      if (!created) return;
      // The popover's hint names what is being labeled: the chapter/page,
      // the in-chapter progress when the locator carries it, and the save.
      const baseLabel = bookmarkBaseLabel(created, isEpub ? epubToc : null);
      setLabelTarget({
        bookmark: created,
        hint: `${bookmarkLocationAndProgress(created, baseLabel)} · Saved just now`,
      });
    } finally {
      bookmarkBusyRef.current = false;
    }
  }, [activePosition, annotations, create, remove, epubToc, isEpub]);
  useShortcut("mod+b", toggleBookmark);
  const closeLabelPopover = useCallback(() => setLabelTarget(null), []);
  const commitBookmarkLabel = useCallback(
    (bookmarkId: number, label: string) => {
      void update(bookmarkId, { label });
    },
    [update],
  );

  const bookmarked =
    activePosition !== null &&
    annotations.some((annotation) => isBookmarkAtPosition(annotation, activePosition));

  const handleCreateHighlight = useCallback(
    (input: AnnotationInput) => {
      void create(input);
    },
    [create],
  );
  const handleSelectionFrom = useCallback((id: number, reported: ReaderSelection | null) => {
    setSelection(reported === null ? null : { bookId: id, ...reported });
  }, []);
  // An existing highlight is edited in place: a color choice recolors the
  // annotation, Remove deletes it outright — never a transparent recolor,
  // which would leave a dead annotation behind.
  const applyHighlightAction = useCallback(
    (annotationId: number, action: HighlightAction) => {
      if (action.type === "remove") void remove(annotationId);
      else void update(annotationId, { color: action.color });
    },
    [remove, update],
  );
  const handleHighlightAction = useCallback(
    (action: HighlightAction) => {
      const target = activeSelection;
      if (target === null) return;
      if (target.highlightId !== null) {
        applyHighlightAction(target.highlightId, action);
        adapterRef.current?.annotations.clearSelection();
        return;
      }
      if (action.type === "setColor") {
        adapterRef.current?.annotations.createHighlight(action.color);
      }
    },
    [activeSelection, applyHighlightAction],
  );
  const handleDismissSelection = useCallback(() => {
    adapterRef.current?.annotations.clearSelection();
  }, []);

  const highlights = useMemo(() => byKind(annotations, "highlight"), [annotations]);

  if (!book) {
    return (
      <div
        data-testid="reader-view"
        className="flex h-screen flex-col items-center justify-center gap-3"
      >
        <h2 className="text-xl font-semibold">This book is no longer in the library</h2>
        <Button variant="outline" size="sm" onClick={() => dispatch({ type: "return-to-library" })}>
          <ArrowLeft data-icon="inline-start" />
          Back to Library
        </Button>
      </div>
    );
  }

  // The initial highlight is read from the annotation list; wait for it so
  // the reader's first restore can land on the row the user clicked instead
  // of opening at the saved position first.
  if (readerTargetAnnotationId != null && !annotationsLoaded) {
    return (
      <div
        data-testid="reader-opening-highlight"
        className="flex h-screen items-center justify-center text-sm text-muted-foreground"
      >
        Opening highlight…
      </div>
    );
  }

  return (
    <div
      ref={readerViewRef}
      data-testid="reader-view"
      data-theme={preferences.theme}
      data-reader-position={Math.round(position)}
      data-pdf-presentation={isPdf && presentation ? "true" : undefined}
      data-epub-presentation={isEpub && presentation ? "true" : undefined}
      className={cn(
        "relative flex h-screen flex-col overflow-hidden",
        THEME_CLASSES[preferences.theme],
      )}
      style={readerChromeVariables(epubSurfaceTheme(preferences.theme))}
    >
      {/* Presentation mode (issues #65 PDF / #64 EPUB) hides the normal
          chrome (header, footer, thumbnails sidebar): the document owns the
          screen, navigation stays on the keyboard and the reader's floating
          bar. */}
      {!presentation && (
        <header className="relative flex shrink-0 items-center gap-1 border-b border-[var(--reader-chrome-border,var(--border))] px-2 py-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                data-testid="reader-back"
                aria-label="Back to Library"
                onClick={() => dispatch({ type: "return-to-library" })}
              >
                <ArrowLeft />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Back to Library</TooltipContent>
          </Tooltip>

          {isPdf && (
            <div
              ref={setPdfControlsHost}
              data-testid="pdf-header-controls"
              className="flex shrink-0 items-center"
            />
          )}

          {isPdf && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  data-testid="reader-sidebar-toggle"
                  aria-label="Toggle page thumbnails"
                  aria-keyshortcuts={formatShortcutAria(READER_PANEL_SHORTCUTS.thumbnails)}
                  aria-pressed={pdfSidebarOpen}
                  onClick={() => setPdfSidebarOpen((open) => !open)}
                >
                  <PanelLeft />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Page thumbnails (Ctrl+Shift+T)</TooltipContent>
            </Tooltip>
          )}

          {/* Spacer: keeps the trailing controls at the right edge. The title
              is centered on the header itself, not on the space between the
              unequal left and right groups, since the PDF zoom controls make
              the left group much wider. */}
          <div className="min-w-0 flex-1" />

          <p
            data-testid="reader-title"
            className="pointer-events-none absolute top-1/2 left-1/2 max-w-[45%] -translate-x-1/2 -translate-y-1/2 truncate text-center text-sm font-medium"
          >
            {book.title}
          </p>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                data-testid="reader-nav-trigger"
                aria-label="Contents and bookmarks"
                aria-keyshortcuts={formatShortcutAria(READER_PANEL_SHORTCUTS.contents)}
                onClick={() => openNav(isEpub ? "contents" : "outline")}
              >
                <TableOfContents />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Contents (Ctrl+Shift+C)</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                data-testid="reader-search"
                aria-label="Search in book"
                aria-keyshortcuts={formatShortcutAria(READER_SEARCH_SHORTCUTS.primary)}
                onClick={() => setSearchOpen(true)}
              >
                <Search />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Search in book ({formatShortcutDisplay(READER_SEARCH_SHORTCUTS.primary)})
            </TooltipContent>
          </Tooltip>

          <ReaderAppearance
            format={book?.format}
            open={appearanceOpen}
            onOpenChange={setAppearanceOpen}
          />

          {isEpub && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  data-testid="epub-presentation-toggle"
                  title="Presentation mode (Ctrl+L)"
                  aria-label="Presentation mode (Ctrl+L)"
                  aria-pressed={presentation}
                  onClick={togglePresentation}
                >
                  <Presentation />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Presentation mode (Ctrl+L)</TooltipContent>
            </Tooltip>
          )}

          <Popover
            open={labelTarget !== null}
            onOpenChange={(open) => {
              if (!open) closeLabelPopover();
            }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <PopoverAnchor asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    data-testid="reader-bookmark"
                    aria-label={bookmarked ? "Remove bookmark" : "Add bookmark"}
                    aria-pressed={bookmarked}
                    onClick={() => void toggleBookmark()}
                  >
                    {bookmarked ? <BookmarkCheck className="fill-current" /> : <Bookmark />}
                  </Button>
                </PopoverAnchor>
              </TooltipTrigger>
              {/* The label popover sits over the same corner: no tooltip on
                  top of it. */}
              {labelTarget === null && <TooltipContent>Bookmark (Ctrl+B)</TooltipContent>}
            </Tooltip>
            {labelTarget !== null && (
              // Keyed by id: a rebind (Ctrl+B at a new position while the
              // popover is up) discards the previous draft and starts blank.
              <BookmarkLabelPopover
                key={labelTarget.bookmark.id}
                bookmarkId={labelTarget.bookmark.id}
                hint={labelTarget.hint}
                theme={preferences.theme}
                onCommit={commitBookmarkLabel}
                onClose={closeLabelPopover}
              />
            )}
          </Popover>
        </header>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {isPdf && pdfSidebarOpen && !presentation && (
          <aside
            ref={setPdfSidebarHost}
            data-testid="pdf-sidebar"
            aria-label="Page thumbnails"
            className="h-full w-44 shrink-0 overflow-hidden border-r"
          />
        )}
        <main
          ref={readerContentRef}
          data-testid="reader-content"
          // Programmatic focus target for panel shortcuts: keeps focus on the
          // reading surface so the nav drawer's focus guard does not grab it
          // when its async contents load.
          tabIndex={-1}
          aria-label="Reading view"
          // overflow-anchor off: Chromium's scroll anchoring adjusts scrollTop
          // when the PDF virtualizer corrects slot heights above the
          // viewport, double-compensating against pdfLayout's own scroll
          // compensation — long jumps then never converge (WebKit has no
          // scroll anchoring, which is why this only bites on Electron).
          // scrollbar-gutter stable: Chromium's classic scrollbars take real
          // width, so without it the fit-width scale recomputes twice (once
          // before, once after the scrollbar appears) and every fit-scale
          // change re-anchors the viewport — long jumps land on the wrong
          // page. WebKitGTK overlay scrollbars made this invisible before.
          className="min-h-0 flex-1 overflow-auto [overflow-anchor:none] [scrollbar-gutter:stable] [scrollbar-color:var(--reader-scrollbar-thumb,auto)]"
          style={
            {
              "--reader-scrollbar-thumb": readerScrollbarColor(epubSurfaceTheme(preferences.theme)),
            } as React.CSSProperties
          }
        >
          {isEpub ? (
            <EpubReader
              key={book.id}
              book={book}
              onTocLoad={(toc) => setEpubTocState({ bookId: book.id, toc })}
              onPositionChange={(position) => setReportedPosition({ bookId: book.id, position })}
              adapterRef={adapterRef}
              initialJump={initialJump}
              onSearchGroup={appendSearchGroupFrom}
              onSearchDone={finishSearchFrom}
              highlights={highlights}
              onCreateHighlight={handleCreateHighlight}
              onSelectionChange={(sel) => handleSelectionFrom(book.id, sel)}
              presentationMode={presentation}
              onExitPresentation={exitPresentation}
            />
          ) : (
            <PdfReader
              key={book.id}
              book={book}
              onDocumentLoad={setPdfPageCount}
              onOutlineLoad={(outline) => setPdfOutlineState({ bookId: book.id, outline })}
              sidebarHost={pdfSidebarHost}
              controlsHost={pdfControlsHost}
              scrollContainerRef={readerContentRef}
              onPositionChange={(position) => setReportedPosition({ bookId: book.id, position })}
              adapterRef={adapterRef}
              initialJump={initialJump}
              onSearchGroup={appendSearchGroupFrom}
              onSearchDone={finishSearchFrom}
              highlights={highlights}
              presentationMode={presentation}
              onExitPresentation={exitPresentation}
              onTogglePresentation={togglePresentation}
              onCreateHighlight={handleCreateHighlight}
              onSelectionChange={(sel) => handleSelectionFrom(book.id, sel)}
            />
          )}
        </main>
      </div>

      {/* Progress footer: EPUB only. A fixed-layout PDF has no meaningful
          "percent read", so the PDF reader shows no bottom bar at all; the
          scrolled EPUB flow keeps an always-visible bar stacked below the
          document. The bar is a slider: clicking (or dragging and releasing)
          it maps that book fraction through the engine's position list
          (EpubReader maps outside position changes onto the nearest
          position). Dragging previews on a local value; only the release
          commits a navigation. */}
      {!presentation && isEpub && (
        <footer
          data-testid="reader-footer"
          data-progress-visible="true"
          className="shrink-0 border-t border-[var(--reader-chrome-border,var(--border))] px-4 py-2"
        >
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            <SliderPrimitive.Root
              ref={progressBarRef}
              data-testid="reader-progress"
              className="relative flex w-full touch-none select-none items-center"
              value={[progressPreview ?? position]}
              min={0}
              max={100}
              step={0.1}
              onValueChange={(values) => {
                const next = values[0] ?? 0;
                setProgressPreview(next);
                readPositioningLabel(next);
              }}
              onValueCommit={(values) => {
                const committed = values[0] ?? 0;
                setProgressPreview(null);
                setPosition(committed);
                readPositioningLabel(committed);
              }}
              onPointerEnter={() => readPositioningLabel(progressPreview ?? position)}
              onPointerDown={() => readPositioningLabel(progressPreview ?? position)}
              onPointerLeave={() => setBarPositioningLabel(null)}
              // A pointer seek is over: hand focus back to the reading
              // surface, so arrows and space go straight back to turning
              // pages instead of nudging the thumb by 0.1% per keypress
              // (the same focus policy as the navigation drawer). Keyboard
              // steering from a Tab-focused thumb keeps its steps.
              onPointerUp={() => {
                const active = document.activeElement;
                if (active instanceof HTMLElement && progressBarRef.current?.contains(active)) {
                  active.blur();
                }
              }}
            >
              {barPositioningLabel !== null && (
                <span
                  data-testid="reader-progress-tooltip"
                  className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs text-background"
                  style={{ left: `${progressPreview ?? position}%` }}
                >
                  {barPositioningLabel}
                </span>
              )}
              <SliderPrimitive.Track
                data-slot="slider-track"
                className="relative h-1 grow overflow-hidden rounded-full bg-[var(--reader-progress-track,var(--muted))]"
              >
                <SliderPrimitive.Range
                  data-slot="slider-range"
                  className="absolute h-full bg-[var(--reader-progress-fill,var(--primary))]"
                />
              </SliderPrimitive.Track>
              <SliderPrimitive.Thumb
                data-slot="slider-thumb"
                aria-label="Reading position"
                className="block size-3.5 shrink-0 cursor-pointer rounded-full border border-[var(--reader-chrome-border,var(--border))] bg-[var(--reader-chrome-card,var(--muted-foreground))] shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--reader-progress-fill,var(--primary))]"
              />
            </SliderPrimitive.Root>
            <span
              data-testid="reader-position"
              className="w-10 text-right text-xs text-[var(--reader-chrome-muted,var(--muted-foreground))] tabular-nums"
            >
              {Math.round(progressPreview ?? position)}%
            </span>
          </div>
        </footer>
      )}

      <ReaderNavigation
        open={nav.open}
        onOpenChange={(open) => setNav((prev) => ({ ...prev, open }))}
        book={book}
        onJump={jump}
        epubToc={isEpub ? epubToc : null}
        pdfOutline={isPdf ? pdfOutline : null}
        annotations={annotations}
        onAnnotationJump={jumpToAnnotation}
        onDeleteAnnotation={(id) => void remove(id)}
        onUpdateAnnotation={(id, patch) => void update(id, patch)}
        tab={nav.tab}
        onTabChange={(tab) => setNav((prev) => ({ ...prev, tab }))}
        colorFor={highlightColorFor}
        theme={preferences.theme}
      />

      <ReaderSearchOverlay
        open={searchOpen}
        onOpenChange={setSearchOpen}
        search={searchState !== null && searchState.bookId === book.id ? searchState : null}
        onSearch={runSearch}
        onPickMatch={pickSearchMatch}
        theme={preferences.theme}
      />

      <SelectionToolbar
        selection={activeSelection}
        onAction={handleHighlightAction}
        onDismiss={handleDismissSelection}
        colorFor={highlightColorFor}
      />
    </div>
  );
}
