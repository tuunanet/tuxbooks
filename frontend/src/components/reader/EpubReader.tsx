import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  EPUB_SCROLLED_SURFACE_MAX_PX,
  epubThemeBackground,
  type EpubFlow,
  type EpubRelocateDetail,
  type EpubSectionProgress,
  type EpubTocItem,
  type ReadiumEpubHandle,
} from "@/lib/epub/readiumEngine";
import { useShortcut } from "@/lib/shortcuts";
import { useReader } from "@/state/readerState";
import { highlightCssColor, isHighlightColor } from "./annotationModel";
import {
  epubProgressPayload,
  type EpubLocator,
  type ReaderAdapter,
  type ReaderPosition,
} from "./readerModel";
import { useReaderProgress } from "./useReaderProgress";
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
  /** Streams one chapter's worth of matches up to the shell. */
  onSearchGroup?: (bookId: number, group: ReaderSearchGroup) => void;
  /** Reports that the running search finished (for this book). */
  onSearchDone?: (bookId: number) => void;
  /** Highlights of the open book; drawn into the engine's overlays. */
  highlights?: Annotation[];
  /** Persists a highlight created from a text selection. */
  onCreateHighlight?: (input: AnnotationInput) => void;
  /** Reports the current selection's text; null when nothing is selected. */
  onSelectionChange?: (selection: { text: string } | null) => void;
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
  onSearchGroup,
  onSearchDone,
  highlights = [],
  onCreateHighlight,
  onSelectionChange,
}: EpubReaderProps) {
  const { preferences, position, setPosition } = useReader();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reportedFractionRef = useRef<number | null>(null);
  const currentSectionRef = useRef<EpubSectionProgress | null>(null);
  const [locator, setLocator] = useState<EpubLocator | null>(null);
  const { status, handle, error } = useEpubDocument(book.id);
  const onPositionChangeRef = useRef(onPositionChange);
  useEffect(() => {
    onPositionChangeRef.current = onPositionChange;
  });

  const handleRelocate = useCallback(
    (view: ReadiumEpubHandle, detail: EpubRelocateDetail) => {
      currentSectionRef.current = detail.section;
      const overall = detail.totalProgression * 100;
      reportedFractionRef.current = detail.totalProgression;
      view.hostElement.dataset.epubSection = String(detail.section.current);
      view.hostElement.dataset.epubSectionTotal = String(detail.section.total);
      // The exact locator the persistence layer would save right now
      // (docs/epub.md stable attributes): E2E reads it for the locator
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
      onSelectionChangeRef.current?.(selection.text === "" ? null : { text: selection.text });
    });
  }, [handle]);

  // Section documents: forward navigation keys — iframe key events never
  // reach the window registry.
  useEffect(() => {
    if (!handle) return;
    return handle.onLoad(({ doc }) => {
      forwardSectionKeys(doc, (key) => {
        const turn = (move: Promise<void>): void => {
          move.catch(() => {});
        };
        if (key === "arrowright" || key === "space" || key === "pagedown") turn(handle.next());
        else if (key === "arrowleft" || key === "pageup") turn(handle.prev());
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
  // versioned adapter's fallback hierarchy (docs/epub.md).
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
          // A stale saved locator can make the engine's load never settle
          // — bound it and fall back to the start of the book instead of
          // wedging the reader on a blank loading surface. A late-settling
          // load is harmless: the engine jumps only to a valid location.
          void Promise.race([
            handle
              .init(record)
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

  // Reflow layout (flow preference) — applied as soon as the renderer exists
  // and on every layout preference change.
  useEffect(() => {
    if (!handle) return;
    const flow: EpubFlow = preferences.layout === "scrolling" ? "scrolled" : "paginated";
    handle.setFlow(flow).catch(() => {});
  }, [handle, preferences.layout, interactive]);

  // User appearance (font size, family override, line spacing, theme colors)
  // through the engine's Preferences API.
  useEffect(() => {
    if (!handle) return;
    void handle.setAppearance({
      fontSize: preferences.fontSize,
      lineHeight: preferences.lineHeight,
      fontFamily: preferences.fontFamily,
      theme: preferences.theme,
    });
  }, [
    handle,
    preferences.fontSize,
    preferences.lineHeight,
    preferences.fontFamily,
    preferences.theme,
    interactive,
  ]);

  // Outside position changes (bookmarks, Home/End, progress bar) map onto
  // the nearest book position; engine-driven changes are skipped via the
  // reported-progress echo guard, mirroring the PDF reader's scroll-report
  // loop guard. Only actual position changes map back — the interactive
  // flip itself must not re-jump an engine that init has already positioned
  // (restored locator or start).
  const previousPositionRef = useRef(0);
  useEffect(() => {
    if (!interactive || !handle) return;
    if (previousPositionRef.current === position) return;
    previousPositionRef.current = position;
    const reported = reportedFractionRef.current;
    if (reported !== null && Math.abs(position - reported * 100) < 0.5) return;
    handle.goToTotalProgression(position / 100).catch(() => {});
  }, [interactive, handle, position]);

  // Window-level page navigation; registered after the shell's handlers, so
  // while an EPUB is open these combos drive the engine, not percentage steps.
  const turnPages = (move: Promise<void> | undefined): void => {
    move?.catch(() => {});
  };
  useShortcut("arrowright", () => turnPages(handle?.next()));
  useShortcut("space", () => turnPages(handle?.next()));
  useShortcut("arrowleft", () => turnPages(handle?.prev()));
  useShortcut("pagedown", () => turnPages(handle?.next()));
  useShortcut("pageup", () => turnPages(handle?.prev()));

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
  // move the diff since the last commit.
  const drawnHighlightsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!handle) return;
    const next = new Map<string, string>();
    for (const highlight of highlights) {
      if (highlight.cfi !== null) next.set(highlight.cfi, highlight.color ?? "");
    }
    for (const [locator, color] of next) {
      if (drawnHighlightsRef.current.get(locator) !== color) {
        handle.addHighlight(locator, highlightCssColor(color));
      }
    }
    for (const locator of drawnHighlightsRef.current.keys()) {
      if (!next.has(locator)) handle.removeHighlight(locator);
    }
    drawnHighlightsRef.current = next;
  }, [handle, highlights]);

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
            onDone: () => onSearchDoneRef.current?.(book.id),
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

  // Bounded measure (PERF-12, docs/performance.md): in scrolled flow the
  // navigator's section iframe spans the full host width, so the container
  // caps it and centers the column; paginated flow keeps the engine's own
  // grid cap and no app-side cap. The root bridges the engine's theme
  // background so the area beside the capped column is seamless with the
  // reading surface in every theme.
  const scrolled = preferences.layout === "scrolling";
  return (
    <div
      data-testid="epub-reader"
      data-epub-state={interactive ? "ready" : "loading"}
      data-layout={preferences.layout}
      className="h-full"
      style={{ backgroundColor: epubThemeBackground(preferences.theme) }}
    >
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
        style={
          scrolled ? { maxWidth: EPUB_SCROLLED_SURFACE_MAX_PX, marginInline: "auto" } : undefined
        }
      />
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
