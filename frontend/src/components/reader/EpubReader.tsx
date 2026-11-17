import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import {
  EPUB_SCROLLED_SURFACE_MAX_PX,
  epubThemeBackground,
  type EpubFlow,
  type EpubRelocateDetail,
  type EpubSectionProgress,
  type EpubTocItem,
  type ReadiumEpubHandle,
} from "@/lib/epub/readiumEngine";
import { epubSurfaceTheme, epubThemeColorScheme } from "@/lib/epub/appearance";
import { useShortcut } from "@/lib/shortcuts";
import { epubBookModeColumnCount, epubBookModeLayout, useReader } from "@/state/readerState";
import { highlightCss, isHighlightColor, readerThemeFamily } from "@/lib/highlightPalette";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import type { ReaderSelection } from "./annotationModel";
import { BOOK_SPREAD_LABEL } from "./bookModeLabels";
import {
  createInstantEpubBookTurn,
  type EpubBookTurnAdapter,
  type EpubTurnDirection,
} from "./epub/epubBookTurn";
import {
  epubProgressPayload,
  type EpubLocator,
  type ReaderAdapter,
  type ReaderJump,
  type ReaderPosition,
} from "./readerModel";
import { useReaderProgress } from "./useReaderProgress";
import { EpubPresentationBar } from "./epub/EpubPresentationBar";
import { EpubBookTurnZones } from "./epub/EpubBookTurnZones";
import { useEpubDocument } from "./epub/hooks/useEpubDocument";
import type { Annotation, AnnotationInput } from "@/types/domain";
import type { Book } from "@/types/domain";
import type { ReaderSearchGroup } from "./searchModel";

interface EpubReaderProps {
  book: Book;
  /** TOC of the opened book, reported once the engine has it. */
  onTocLoad?: (toc: EpubTocItem[]) => void;
  /**
   * Reports the engine's latest position (locator + spine href) on every
   * relocate — the exact position a bookmark would be placed at. Event
   * callbacks, not effects: relocates already drive a render.
   */
  onPositionChange?: (position: ReaderPosition) => void;
  /**
   * Filled with this reader's shell adapter while the engine is open: jump,
   * search, and highlight creation. Nulled on unmount/book switch.
   */
  adapterRef?: MutableRefObject<ReaderAdapter | null>;
  /**
   * Initial destination for a reader opened from a highlight. Applied as
   * part of the restore so the saved position cannot overwrite it.
   */
  initialJump?: ReaderJump | null;
  /** Streams one chapter's worth of matches up to the shell. */
  onSearchGroup?: (bookId: number, group: ReaderSearchGroup) => void;
  /** Reports that the running search finished (for this book). */
  onSearchDone?: (bookId: number, truncated: boolean) => void;
  /** Highlights of the open book; drawn into the engine's overlays. */
  highlights?: Annotation[];
  /** Persists a highlight created from a text selection. */
  onCreateHighlight?: (input: AnnotationInput) => void;
  /**
   * Reports the current selection's text; null when nothing is selected.
   * EPUB selections never target an existing highlight from the toolbar —
   * highlight editing lives in the navigation drawer.
   */
  onSelectionChange?: (selection: ReaderSelection | null) => void;
  /**
   * Presentation mode (issue #64, the PDF twin is issue #65): the shell
   * hides its chrome around this surface; the reader adds the floating
   * bar. Position and appearance need no special handling — the engine
   * keeps the locator across the relayout, and the preferences are state,
   * not chrome.
   */
  presentationMode?: boolean;
  /** Exits presentation mode (the in-mode exit control). */
  onExitPresentation?: () => void;
  /**
   * Injected turn adapter (the component-test seam, mirroring
   * PdfBookView's): when present it drives every book-mode turn — zones
   * and keyboard alike — instead of the reader's own turn adapter.
   */
  turnAdapter?: EpubBookTurnAdapter | null;
}

/** Keys forwarded from section documents to the engine's page navigation. */
const NAVIGATION_KEYS = new Set(["arrowright", "arrowleft", "space", "pagedown", "pageup"]);

/**
 * Upper bound on the engine's restore-to-saved-locator step (a stale saved
 * locator can leave the engine's load unsettled). Generous against the
 * healthy path (sub-second); tight enough that a wedged restore degrades to
 * a start-of-book open instead of a blank reader.
 */
const EPUB_RESTORE_TIMEOUT_MS = 10_000;

/**
 * EPUB reading surface and the shell's EPUB adapter, powered by the Readium
 * engine (see `lib/epub/readiumEngine.ts`). Initialization follows the PDF
 * reader's lifecycle: DOCUMENT_READY → POSITION_RESTORED → INTERACTIVE, so
 * a reader never flashes the start of the book before jumping to the
 * restored locator.
 *
 * Progress mapping: the engine reports the locator's totalProgression, so
 * the shell's coarse position (0–100) is the book fraction directly, and
 * outside position changes (bookmarks, Home/End) map back onto the nearest
 * position — the locator stays the exact locator either way.
 */
export function EpubReader({
  book,
  onTocLoad,
  onPositionChange,
  adapterRef,
  initialJump,
  onSearchGroup,
  onSearchDone,
  highlights = [],
  onCreateHighlight,
  onSelectionChange,
  presentationMode = false,
  onExitPresentation,
  turnAdapter = null,
}: EpubReaderProps) {
  const { preferences, effectiveTheme, position, setPosition } = useReader();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reportedFractionRef = useRef<number | null>(null);
  const currentSectionRef = useRef<EpubSectionProgress | null>(null);
  const [locator, setLocator] = useState<EpubLocator | null>(null);
  const [section, setSection] = useState<EpubSectionProgress | null>(null);
  const { status, handle, error } = useEpubDocument(book.id);
  // Capture the mount-time destination: the shell clears it once the annotation list resolves.
  const initialJumpRef = useRef(initialJump);
  const onPositionChangeRef = useRef(onPositionChange);
  useEffect(() => {
    onPositionChangeRef.current = onPositionChange;
  });

  const handleRelocate = useCallback(
    (view: ReadiumEpubHandle, detail: EpubRelocateDetail) => {
      currentSectionRef.current = detail.section;
      setSection(detail.section);
      const overall = detail.totalProgression * 100;
      reportedFractionRef.current = detail.totalProgression;
      view.hostElement.dataset.epubSection = String(detail.section.current);
      view.hostElement.dataset.epubSectionTotal = String(detail.section.total);
      view.hostElement.dataset.epubLocator = detail.locator;
      const chapterHref = view.getSectionHref(detail.section.current);
      setLocator({ locator: detail.locator, chapterHref });
      onPositionChangeRef.current?.({ format: "epub", locator: detail.locator, chapterHref });
      setPosition(overall);
    },
    [setPosition],
  );

  // Ready must wait for the restore to settle: an early ready lets the restore's
  // frame update land after a user turn, and E2E keys race the restore.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!handle) return;
    return handle.onRelocate((detail) => {
      if (restoredRef.current) handle.hostElement.dataset.epubState = "ready";
      handle.hostElement.dataset.epubFraction = String(detail.fraction);
      handleRelocate(handle, detail);
    });
  }, [handle, handleRelocate]);

  const onSelectionChangeRef = useRef(onSelectionChange);
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  });
  useEffect(() => {
    if (!handle) return;
    return handle.onSelection((selection) => {
      onSelectionChangeRef.current?.(
        selection.text === "" ? null : { text: selection.text, highlightId: null },
      );
    });
  }, [handle]);

  const turnSpreadRef = useRef<(direction: EpubTurnDirection) => void>(() => {});
  useEffect(() => {
    if (!handle) return;
    return handle.onLoad(({ doc }) => {
      forwardSectionKeys(doc, (key) => {
        if (key === "arrowright" || key === "space" || key === "pagedown") {
          turnSpreadRef.current("next");
        } else if (key === "arrowleft" || key === "pageup") {
          turnSpreadRef.current("prev");
        }
      });
    });
  }, [handle]);

  // Subscribing cancels the engine's default link navigation; log and drop the link.
  useEffect(() => {
    if (!handle) return;
    return handle.onExternalLink((href) => {
      console.warn(`Blocked external link from EPUB content: ${href}`);
    });
  }, [handle]);

  const [hostMounted, setHostMounted] = useState(false);
  const [restored, setRestored] = useState(false);
  useReaderProgress<EpubSavedState>({
    bookId: book.id,
    enabled: status === "ready" && hostMounted,
    current: locator,
    position,
    parseRestored: (record) => (record === null ? null : { record }),
    onRestored: useCallback(
      (saved: EpubSavedState | null) => {
        const record = saved !== null && "record" in saved ? saved.record : null;
        if (handle) {
          const target = initialJumpRef.current;
          void Promise.race([
            (target?.format === "epub"
              ? handle.init(null).then(() => handle.goTo(target.locator))
              : handle.init(record)
            )
              .then(() => {
                restoredRef.current = true;
              })
              .catch(() => {}),
            new Promise<void>((resolve) => window.setTimeout(resolve, EPUB_RESTORE_TIMEOUT_MS)),
          ]).finally(() => {
            restoredRef.current = true;
            if (currentSectionRef.current !== null) {
              handle.hostElement.dataset.epubState = "ready";
            }
            setRestored(true);
          });
        } else {
          restoredRef.current = true;
          setRestored(true);
        }
      },
      [handle],
    ),
    savePayload: (current, value) =>
      "record" in current ? { progressPercent: value } : epubProgressPayload(current, value),
  });
  const interactive = status === "ready" && restored;

  const onTocLoadRef = useRef(onTocLoad);
  useEffect(() => {
    onTocLoadRef.current = onTocLoad;
  });
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !handle) return;
    const host = handle.hostElement;
    container.appendChild(host);
    setHostMounted(true);
    onTocLoadRef.current?.(handle.getToc());
    return () => {
      host.remove();
      setHostMounted(false);
    };
  }, [handle]);

  const layout = epubBookModeLayout(preferences);
  const columnCount = epubBookModeColumnCount(preferences);

  const reducedMotion = usePrefersReducedMotion();
  const createdInstantTurn = useMemo(
    () =>
      handle
        ? createInstantEpubBookTurn({
            reducedMotion,
            move: async (direction) => {
              await (direction === "next" ? handle.next() : handle.prev());
              return handle.getCurrentLocator();
            },
          })
        : null,
    [handle, reducedMotion],
  );
  const bookTurnActive = preferences.bookMode && !presentationMode;
  const turn = bookTurnActive ? (turnAdapter ?? createdInstantTurn) : null;
  const turnSpread = (direction: EpubTurnDirection): void => {
    if (turn) {
      if (direction === "next") turn.advance();
      else turn.retreat();
      return;
    }
    const move = direction === "next" ? handle?.next() : handle?.prev();
    move?.catch(() => {});
  };
  useEffect(() => {
    turnSpreadRef.current = turnSpread;
  });

  useEffect(() => {
    if (!handle) return;
    const flow: EpubFlow = layout === "scrolling" ? "scrolled" : "paginated";
    handle.setFlow(flow).catch(() => {});
  }, [handle, layout, interactive]);

  useEffect(() => {
    if (!handle) return;
    void handle.setAppearance({
      fontSize: preferences.epubFontSize,
      lineHeight: preferences.lineHeight,
      fontFamily: preferences.fontFamily,
      columnCount,
      wordSpacing: preferences.wordSpacing,
      letterSpacing: preferences.letterSpacing,
      paragraphSpacing: preferences.paragraphSpacing,
      pageGutter: preferences.pageGutter,
      textAlign: preferences.textAlign,
      foreground: preferences.foreground,
      theme: epubSurfaceTheme(effectiveTheme),
    });
  }, [
    handle,
    preferences.epubFontSize,
    preferences.lineHeight,
    preferences.fontFamily,
    columnCount,
    preferences.wordSpacing,
    preferences.letterSpacing,
    preferences.paragraphSpacing,
    preferences.pageGutter,
    preferences.textAlign,
    preferences.foreground,
    effectiveTheme,
    interactive,
  ]);

  // Echo guard: relocates echo back as reported * 100; the epsilon must stay far
  // below the progress bar's 0.1% keyboard step.
  const previousPositionRef = useRef(0);
  useEffect(() => {
    if (!interactive || !handle) return;
    if (previousPositionRef.current === position) return;
    previousPositionRef.current = position;
    const reported = reportedFractionRef.current;
    if (reported !== null && Math.abs(position - reported * 100) < 1e-6) return;
    handle.goToTotalProgression(position / 100).catch(() => {});
  }, [interactive, handle, position]);

  const turnPages = (move: Promise<void> | undefined): void => {
    move?.catch(() => {});
  };
  useShortcut("arrowright", () => turnSpread("next"));
  useShortcut("space", () => turnSpread("next"));
  useShortcut("arrowleft", () => turnSpread("prev"));
  useShortcut("pagedown", () => turnSpread("next"));
  useShortcut("pageup", () => turnSpread("prev"));

  const onSearchGroupRef = useRef(onSearchGroup);
  const onSearchDoneRef = useRef(onSearchDone);
  useEffect(() => {
    onSearchGroupRef.current = onSearchGroup;
    onSearchDoneRef.current = onSearchDone;
  });

  const drawnHighlightsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!handle) return;
    const family = readerThemeFamily(effectiveTheme);
    const next = new Map<string, string>();
    for (const highlight of highlights) {
      if (highlight.cfi !== null) {
        next.set(
          highlight.cfi,
          highlightCss(highlight.color, family, preferences.highlightOverrides),
        );
      }
    }
    for (const [locator, css] of next) {
      if (drawnHighlightsRef.current.get(locator) !== css) {
        handle.addHighlight(locator, css);
      }
    }
    for (const locator of drawnHighlightsRef.current.keys()) {
      if (!next.has(locator)) handle.removeHighlight(locator);
    }
    drawnHighlightsRef.current = next;
  }, [handle, highlights, effectiveTheme, preferences.highlightOverrides]);

  const onCreateHighlightRef = useRef(onCreateHighlight);
  useEffect(() => {
    onCreateHighlightRef.current = onCreateHighlight;
  });

  useEffect(() => {
    if (!adapterRef) return;
    if (!handle) {
      adapterRef.current = null;
      return;
    }
    let cancelLast: (() => void) | null = null;
    let unlabeledOrdinal = 0;
    adapterRef.current = {
      jump: (target) => {
        if (target.format !== "epub") return;
        void handle.goTo(target.locator);
      },
      progressionIndexFor: (fraction) => handle.timelineIndexFor(fraction),
      search: {
        run: (query: string) => {
          cancelLast?.();
          unlabeledOrdinal = 0;
          cancelLast = handle.search(query, {
            onSection: (section) => {
              const label = section.label !== "" ? section.label : `Chapter ${++unlabeledOrdinal}`;
              onSearchGroupRef.current?.(book.id, {
                label,
                matches: section.subitems.map((match) => ({
                  locator: match.locator,
                  page: null,
                  excerpt: match.excerpt,
                })),
              });
            },
            onDone: (truncated) => onSearchDoneRef.current?.(book.id, truncated),
          });
        },
        cancel: () => cancelLast?.(),
      },
      annotations: {
        createHighlight: (color) => {
          const located = handle.getLocatorFromSelection();
          handle.clearSelection();
          onSelectionChangeRef.current?.(null);
          if (!located) return;
          onCreateHighlightRef.current?.({
            kind: "highlight",
            cfi: located.locator,
            chapterHref: located.href,
            text: located.text,
            color: isHighlightColor(color) ? color : null,
          });
        },
        clearSelection: () => {
          handle.clearSelection();
          onSelectionChangeRef.current?.(null);
        },
      },
    };
    return () => {
      cancelLast?.();
      adapterRef.current = null;
    };
  }, [adapterRef, handle, book.id]);

  if (status === "error") {
    return (
      <div data-testid="epub-reader" className="mx-auto max-w-3xl px-6 py-8">
        <p
          data-testid="epub-error"
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
        >
          This EPUB could not be opened: {error}
        </p>
      </div>
    );
  }

  // Bounded measure (PERF-12): scrolled flow spans the host iframe, so cap and center it.
  const scrolled = layout === "scrolling";
  return (
    <div
      data-testid="epub-reader"
      data-epub-state={interactive ? "ready" : "loading"}
      // Effective layout (book mode derives paginated), not the stored preference.
      data-layout={layout}
      data-epub-presentation={presentationMode}
      className="relative h-full"
      style={{
        backgroundColor: epubThemeBackground(epubSurfaceTheme(effectiveTheme)),
        // color-scheme inherits into the navigator's iframes; pin it to the theme family.
        colorScheme: epubThemeColorScheme(epubSurfaceTheme(effectiveTheme)),
      }}
    >
      {presentationMode && (
        <EpubPresentationBar
          section={section}
          onPrev={() => turnPages(handle?.prev())}
          onNext={() => turnPages(handle?.next())}
          onExit={onExitPresentation}
        />
      )}
      {!interactive && (
        <p
          data-testid="epub-loading"
          className="px-6 py-8 text-center text-sm text-muted-foreground"
        >
          Loading {book.title}…
        </p>
      )}
      <div
        ref={containerRef}
        className="h-full"
        data-epub-measure={scrolled ? "capped" : "full"}
        {...(bookTurnActive ? { role: "region", "aria-label": BOOK_SPREAD_LABEL } : null)}
        style={{
          ...(scrolled ? { maxWidth: EPUB_SCROLLED_SURFACE_MAX_PX, marginInline: "auto" } : null),
        }}
      />
      {bookTurnActive && interactive && <EpubBookTurnZones turn={turnSpread} />}
    </div>
  );
}

/**
 * The persistence-hook state for the EPUB reader: either the live locator
 * (what saves persist) or a restore envelope wrapping the fetched record
 * (what the engine seam resolves).
 */
type EpubSavedState = EpubLocator | { record: Parameters<ReadiumEpubHandle["init"]>[0] };

/**
 * Forward keys that happen while focus is inside a section document to the
 * reader's navigation handler. Attached once per document (WeakSet).
 */
const keyedDocs = new WeakSet<Document>();
function forwardSectionKeys(doc: Document, handler: (key: string) => void): void {
  if (keyedDocs.has(doc)) return;
  keyedDocs.add(doc);
  doc.addEventListener("keydown", (event) => {
    const target = event.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
    ) {
      return;
    }
    const key = event.key === " " ? "space" : event.key.toLowerCase();
    if (NAVIGATION_KEYS.has(key)) {
      event.preventDefault();
      handler(key);
    }
  });
}
