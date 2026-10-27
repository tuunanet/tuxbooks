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
  createRotationEpubBookTurn,
  EPUB_TURN_PHASE_MS,
  type EpubBookTurnAdapter,
  type EpubTurnDirection,
  type EpubTurnPhase,
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
   * and keyboard alike — instead of the reader's own rotation adapter.
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
  const { preferences, position, setPosition } = useReader();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reportedFractionRef = useRef<number | null>(null);
  const currentSectionRef = useRef<EpubSectionProgress | null>(null);
  const [locator, setLocator] = useState<EpubLocator | null>(null);
  // Spine position for the presentation bar's indicator (a ref alone would
  // not re-render; relocates already re-render via setLocator, and the two
  // states commit together).
  const [section, setSection] = useState<EpubSectionProgress | null>(null);
  const { status, handle, error } = useEpubDocument(book.id);
  // The initial destination is captured when the reader mounts: the shell
  // clears the app-state target as soon as the annotation list resolves.
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
      // The exact locator the persistence layer would save right now
      // (docs/EPUB.md stable attributes): E2E reads it for the locator
      // round-trip regression test instead of inferring position from
      // page-level state.
      view.hostElement.dataset.epubLocator = detail.locator;
      const chapterHref = view.getSectionHref(detail.section.current);
      setLocator({ locator: detail.locator, chapterHref });
      // Bookmarks read this state; it must hold the exact locator a
      // bookmark placed right now would persist.
      onPositionChangeRef.current?.({ format: "epub", locator: detail.locator, chapterHref });
      setPosition(overall);
    },
    [setPosition],
  );

  // Relocate → shell position + persistence locator; also flips the host's
  // E2E state attributes to "ready". The ready flip must wait for the
  // restore to settle (restoredRef below): the engine's first relocate can
  // report the initial position while the restored locator's frame update
  // is still in flight — a "ready" reader would then visibly jump when the
  // restore lands, and E2E navigation keys pressed in that window race the
  // restore (the frame pool's per-href in-flight update can re-apply the
  // restored locator over an early user navigation).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (!handle) return;
    return handle.onRelocate((detail) => {
      if (restoredRef.current) handle.hostElement.dataset.epubState = "ready";
      handle.hostElement.dataset.epubFraction = String(detail.fraction);
      handleRelocate(handle, detail);
    });
  }, [handle, handleRelocate]);

  // Text selections inside a section document become highlight candidates:
  // the engine hands over the selection (with the live DOM range from its
  // same-origin frame), kept so creation translates it to a canonical
  // locator at the moment the user picks a color.
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

  // Section documents: forward navigation keys — iframe key events never
  // reach the window registry. Routed through the turn ref so book mode
  // animates frame-originated turns exactly like window ones. One
  // direction vocabulary across the turn path: "next"/"prev".
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

  // External links must not navigate the reading surface; the engine's
  // handleLocator interception is cancelled by this subscription's existence.
  useEffect(() => {
    if (!handle) return;
    return handle.onExternalLink((href) => {
      console.warn(`Blocked external link from EPUB content: ${href}`);
    });
  }, [handle]);

  // Restore path: the record passes through untouched; the engine seam
  // resolves Readium rows directly and migrates foliate rows through the
  // versioned adapter's fallback hierarchy (docs/EPUB.md).
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
          // A stale saved locator can make the engine's load never settle
          // — bound it and fall back to the start of the book instead of
          // wedging the reader on a blank loading surface. A late-settling
          // load is harmless: the engine jumps only to a valid location.
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
            // A wedged restore degrades to ready-at-start: the reader must
            // never stay locked on the loading surface. The engine's own
            // locator resolution is untouched by this flag — it only gates
            // the E2E ready attribute (see the relocate subscription).
            restoredRef.current = true;
            if (currentSectionRef.current !== null) {
              // The restore's own relocate already landed during init; the
              // reader is at its position — flip ready now (no further
              // relocate will fire on its own).
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

  // Mount the engine's host element exactly once per opened handle and
  // report the TOC (available as soon as the publication is built).
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

  // Book mode (spec tuxbooks-9pr) derives over the stored preferences: it
  // implies a paginated two-column flow while the stored layout and column
  // count stay intact for when the mode turns off again.
  const layout = epubBookModeLayout(preferences);
  const columnCount = epubBookModeColumnCount(preferences);

  // Turn routing (tuxbooks-9pr.7): while book mode is on, every turn —
  // zones, window keys, and section-frame keys alike — goes through one
  // turn adapter, so the rotation animation has a single path. The view
  // reads the reduced-motion media query and passes the flag into the
  // adapter; the adapter itself never reads it (spec → Reduced motion).
  // Presentation mode keeps its own direct page stepping. Directions are
  // "next"/"prev" everywhere in this path; the adapter's advance/retreat
  // verbs are translated here, at the seam.
  const reducedMotion = usePrefersReducedMotion();
  const [turnSurface, setTurnSurface] = useState<{
    phase: EpubTurnPhase;
    direction: EpubTurnDirection;
  }>({ phase: "idle", direction: "next" });
  const createdRotationTurn = useMemo(
    () =>
      handle
        ? createRotationEpubBookTurn({
            reducedMotion,
            move: (direction) => (direction === "next" ? handle.next() : handle.prev()),
            setPhase: (phase, direction) => setTurnSurface({ phase, direction }),
          })
        : null,
    [handle, reducedMotion],
  );
  const bookTurnActive = preferences.bookMode && !presentationMode;
  const turn = bookTurnActive ? (turnAdapter ?? createdRotationTurn) : null;
  const turnSpread = (direction: EpubTurnDirection): void => {
    if (turn) {
      if (direction === "next") turn.advance();
      else turn.retreat();
      return;
    }
    const move = direction === "next" ? handle?.next() : handle?.prev();
    move?.catch(() => {});
  };
  // Section-frame keys reach navigation through this ref (their effect
  // registers before the adapter exists); refreshed every render so a
  // frame press always sees the live turn.
  useEffect(() => {
    turnSpreadRef.current = turnSpread;
  });

  // Reflow layout (flow preference) — applied as soon as the renderer exists
  // and on every layout preference change.
  useEffect(() => {
    if (!handle) return;
    const flow: EpubFlow = layout === "scrolling" ? "scrolled" : "paginated";
    handle.setFlow(flow).catch(() => {});
  }, [handle, layout, interactive]);

  // User appearance (font size, family override, line spacing, columns,
  // text layout, theme colors) through the engine's Preferences API.
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
      theme: epubSurfaceTheme(preferences.theme),
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
    preferences.theme,
    interactive,
  ]);

  // Outside position changes (bookmarks, Home/End, progress bar) map onto
  // the nearest book position; engine-driven changes are skipped via the
  // reported-progress echo guard, mirroring the PDF reader's scroll-report
  // loop guard. Only actual position changes map back — the interactive
  // flip itself must not re-jump an engine that init has already positioned
  // (restored locator or start).
  //
  // The echo is exact by construction: a relocate's echo arrives as
  // `reported * 100`, the same float the guard compares against, so the
  // epsilon only needs to ride out float noise. It must stay far below the
  // progress bar's 0.1% keyboard step. The old 0.5 window read genuine
  // thumb steps as echoes and dropped them, leaving the pages unmoved
  // while the slider ran ahead.
  const previousPositionRef = useRef(0);
  useEffect(() => {
    if (!interactive || !handle) return;
    if (previousPositionRef.current === position) return;
    previousPositionRef.current = position;
    const reported = reportedFractionRef.current;
    if (reported !== null && Math.abs(position - reported * 100) < 1e-6) return;
    handle.goToTotalProgression(position / 100).catch(() => {});
  }, [interactive, handle, position]);

  // Window-level page navigation; registered after the shell's handlers, so
  // while an EPUB is open these combos drive the engine, not percentage steps.
  // In book mode they step by spread through the turn adapter.
  const turnPages = (move: Promise<void> | undefined): void => {
    move?.catch(() => {});
  };
  useShortcut("arrowright", () => turnSpread("next"));
  useShortcut("space", () => turnSpread("next"));
  useShortcut("arrowleft", () => turnSpread("prev"));
  useShortcut("pagedown", () => turnSpread("next"));
  useShortcut("pageup", () => turnSpread("prev"));

  // In-book search runs on the engine and streams matches up to the shell;
  // callbacks reach the shell through refs so re-renders never re-register
  // the adapter. Unmounting (book switch) cancels a running search.
  const onSearchGroupRef = useRef(onSearchGroup);
  const onSearchDoneRef = useRef(onSearchDone);
  useEffect(() => {
    onSearchGroupRef.current = onSearchGroup;
    onSearchDoneRef.current = onSearchDone;
  });

  // Draw highlights through the engine and keep them in step with the
  // persisted list (created in the tabs, deleted, recolored). The navigator
  // re-applies group decorations to mounted frames, so this only has to
  // move the diff since the last commit. The diff runs on resolved CSS, so
  // a palette override or theme-family flip with the book open repaints.
  const drawnHighlightsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!handle) return;
    const family = readerThemeFamily(preferences.theme);
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
  }, [handle, highlights, preferences.theme, preferences.highlightOverrides]);

  // The shell's selection toolbar drives highlight creation through this
  // controller; the reader owns the selection → locator translation.
  const onCreateHighlightRef = useRef(onCreateHighlight);
  useEffect(() => {
    onCreateHighlightRef.current = onCreateHighlight;
  });

  // The shell adapter: one object covering jumps (TOC hrefs, bookmark and
  // search locators — the engine accepts all, migrating legacy foliate CFIs
  // on the fly), search, and highlight creation. Registered only while a
  // handle is open, so a switched book can never be driven through a stale
  // engine.
  useEffect(() => {
    if (!adapterRef) return;
    if (!handle) {
      adapterRef.current = null;
      return;
    }
    let cancelLast: (() => void) | null = null;
    // Chapter numbering fallback for books without TOC labels.
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

  // Bounded measure (PERF-12, docs/PERFORMANCE.md): in scrolled flow the
  // navigator's section iframe spans the full host width, so the container
  // caps it and centers the column; paginated flow keeps the engine's own
  // grid cap and no app-side cap. The root bridges the engine's theme
  // background so the area beside the capped column is seamless with the
  // reading surface in every theme.
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
        backgroundColor: epubThemeBackground(epubSurfaceTheme(preferences.theme)),
        // Pin the section documents' UA-default colors to the theme family
        // instead of the OS/global scheme (color-scheme inherits into the
        // navigator's iframes).
        colorScheme: epubThemeColorScheme(epubSurfaceTheme(preferences.theme)),
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
        className={`h-full${bookTurnActive ? " epub-turn-surface" : ""}`}
        data-epub-measure={scrolled ? "capped" : "full"}
        // Published turn phase: the surface's CSS keys the rotation
        // keyframes off these, and tests/E2E read them as the turn's
        // external contract. Idle and unset are the same rest state.
        data-epub-turn-phase={bookTurnActive ? turnSurface.phase : undefined}
        data-epub-turn-direction={bookTurnActive ? turnSurface.direction : undefined}
        // Assistive tech (tuxbooks-9pr.8): in book mode this surface is
        // the book — a named region, matching the PDF book view. The
        // plain reading surface stays an unlabelled container.
        {...(bookTurnActive ? { role: "region", "aria-label": BOOK_SPREAD_LABEL } : null)}
        style={{
          ...(scrolled ? { maxWidth: EPUB_SCROLLED_SURFACE_MAX_PX, marginInline: "auto" } : null),
          ...(bookTurnActive ? { "--epub-turn-phase-ms": `${EPUB_TURN_PHASE_MS}ms` } : null),
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
