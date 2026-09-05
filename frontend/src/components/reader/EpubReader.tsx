import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  EpubViewHandle,
  epubAppearanceCss,
  type EpubFlow,
  type EpubRelocateDetail,
  type EpubSectionProgress,
  type EpubTocItem,
} from "@/lib/epub/epubEngine";
import { useShortcut } from "@/lib/shortcuts";
import { useReader } from "@/state/readerState";
import { highlightCssColor, isHighlightColor } from "./annotationModel";
import {
  epubProgressPayload,
  parseEpubProgress,
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
   * Reports the engine's latest position (CFI + spine href) on every
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
 * EPUB reading surface and the shell's EPUB adapter, powered by the
 * foliate-js engine (see `lib/epub/epubEngine.ts`). Initialization follows
 * the PDF reader's lifecycle: DOCUMENT_READY → POSITION_RESTORED →
 * INTERACTIVE, so a reader never flashes the start of the book before
 * jumping to the restored CFI.
 *
 * Progress mapping: the engine does not report byte sizes, so the shell's
 * coarse position (0–100) is derived from the spine position
 * (`(current + in-section fraction) / total`), and outside position changes
 * (bookmarks, Home/End) map back onto the nearest spine section — the CFI
 * stays the exact locator either way.
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
  const mathCountsRef = useRef(new Map<number, number>());
  const [locator, setLocator] = useState<EpubLocator | null>(null);

  const { status, handle, error } = useEpubDocument(book.id);
  const onPositionChangeRef = useRef(onPositionChange);
  useEffect(() => {
    onPositionChangeRef.current = onPositionChange;
  });

  // Shell-level progress from spine position; the engine's in-section page
  // fraction refines it where the engine reports one.
  const overallPercent = (section: EpubSectionProgress, inSection: number): number => {
    const total = section.total > 0 ? section.total : 1;
    return ((section.current + inSection) / total) * 100;
  };

  const syncMathCount = useCallback((view: EpubViewHandle, section: EpubSectionProgress) => {
    view.host.dataset.epubDocMathCount = String(mathCountsRef.current.get(section.current) ?? 0);
  }, []);

  const handleRelocate = useCallback(
    (view: EpubViewHandle, detail: EpubRelocateDetail) => {
      currentSectionRef.current = detail.section;
      // Shell-level refinement: the paginated renderer's fraction is
      // page-based per section and swings past 1 on short sections, so it
      // is only trusted in scrolled flow; paginated progress moves in
      // chapter steps. The CFI stays the exact locator either way.
      const inSection =
        preferences.layout === "scrolling" && Number.isFinite(detail.fraction)
          ? Math.min(Math.max(detail.fraction, 0), 1)
          : 0;
      const overall = overallPercent(detail.section, inSection);
      reportedFractionRef.current = overall / 100;
      view.host.dataset.epubSection = String(detail.section.current);
      view.host.dataset.epubSectionTotal = String(detail.section.total);
      syncMathCount(view, detail.section);
      const chapterHref = view.getSectionHref(detail.section.current) ?? null;
      setLocator({ cfi: detail.cfi, chapterHref });
      // Bookmarks read this state; it must hold the exact locator a
      // bookmark placed right now would persist.
      onPositionChangeRef.current?.({ format: "epub", cfi: detail.cfi, chapterHref });
      setPosition(overall);
    },
    [setPosition, syncMathCount, preferences.layout],
  );

  // Relocate → shell position + persistence locator; also flips the host's
  // E2E state attributes to "ready" (the first relocate follows init).
  useEffect(() => {
    if (!handle) return;
    return handle.onRelocate((detail) => {
      handle.host.dataset.epubState = "ready";
      handle.host.dataset.epubFraction = String(detail.fraction);
      handleRelocate(handle, detail);
    });
  }, [handle, handleRelocate]);

  // Text selections inside a section document become highlight candidates:
  // the range is kept (not copied to pixels) so creation translates it to a
  // canonical CFI at the moment the user picks a color.
  const pendingSelectionRef = useRef<{ doc: Document; range: Range; text: string } | null>(null);
  const onSelectionChangeRef = useRef(onSelectionChange);
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  });
  const captureSelectionOnPointerUp = useCallback((doc: Document) => {
    doc.addEventListener("pointerup", () => {
      window.setTimeout(() => {
        const selection = doc.getSelection();
        const text = selection?.toString().replace(/\s+/g, " ").trim() ?? "";
        if (!selection || selection.isCollapsed || selection.rangeCount === 0 || text === "") {
          pendingSelectionRef.current = null;
          onSelectionChangeRef.current?.(null);
          return;
        }
        pendingSelectionRef.current = {
          doc,
          range: selection.getRangeAt(0).cloneRange(),
          text,
        };
        onSelectionChangeRef.current?.({ text });
      }, 0);
    });
  }, []);

  // Section documents: record MathML presence per spine section (E2E
  // attribute reflects the current section), forward navigation keys —
  // iframe key events never reach the window registry — schedule a
  // relayout once the section's fonts have settled (the engine's deferred
  // re-expand can otherwise collapse a section to zero width; see
  // EpubViewHandle.relayout), and capture text selections for highlights.
  useEffect(() => {
    if (!handle) return;
    return handle.onLoad(({ index, doc }) => {
      mathCountsRef.current.set(index, doc.querySelectorAll("math").length);
      const section = currentSectionRef.current;
      if (section) syncMathCount(handle, section);
      forwardSectionKeys(doc, (key) => {
        if (key === "arrowright" || key === "space" || key === "pagedown") void handle.next();
        else if (key === "arrowleft" || key === "pageup") void handle.prev();
      });
      scheduleFontsSettledRelayout(doc, () => handle.relayout());
      captureSelectionOnPointerUp(doc);
    });
  }, [handle, syncMathCount, captureSelectionOnPointerUp]);

  // External links must not navigate the reading surface; the engine's
  // default window.open is cancelled by this subscription's existence.
  useEffect(() => {
    if (!handle) return;
    return handle.onExternalLink((href) => {
      console.warn(`Blocked external link from EPUB content: ${href}`);
    });
  }, [handle]);

  const [restored, setRestored] = useState(false);
  useReaderProgress<EpubLocator>({
    bookId: book.id,
    enabled: status === "ready",
    current: locator,
    position,
    parseRestored: (record) => {
      const cfi = parseEpubProgress(record);
      return cfi === null ? null : { cfi, chapterHref: null };
    },
    onRestored: useCallback(
      (saved: EpubLocator | null) => {
        if (handle) {
          void handle.init(saved?.cfi ?? null).finally(() => setRestored(true));
        } else {
          setRestored(true);
        }
      },
      [handle],
    ),
    savePayload: epubProgressPayload,
  });
  const interactive = status === "ready" && restored;

  // Mount the engine's host element exactly once per opened handle and
  // report the TOC (available as soon as the book is parsed).
  const onTocLoadRef = useRef(onTocLoad);
  useEffect(() => {
    onTocLoadRef.current = onTocLoad;
  });
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !handle) return;
    const host = handle.host;
    container.appendChild(host);
    onTocLoadRef.current?.(handle.getToc());
    return () => {
      host.remove();
    };
  }, [handle]);

  // Reflow layout (flow attribute) — applied as soon as the renderer exists
  // and on every layout preference change.
  useEffect(() => {
    if (!handle) return;
    const flow: EpubFlow = preferences.layout === "scrolling" ? "scrolled" : "paginated";
    handle.setFlow(flow);
  }, [handle, preferences.layout, interactive]);

  // User appearance stylesheet, applied to every section document by the
  // engine's setStyles (and re-applied by the engine per section load).
  useEffect(() => {
    if (!handle) return;
    handle.setAppearance(
      epubAppearanceCss({
        fontSize: preferences.fontSize,
        lineHeight: preferences.lineHeight,
        fontFamily: preferences.fontFamily,
        theme: preferences.theme,
      }),
    );
  }, [
    handle,
    preferences.fontSize,
    preferences.lineHeight,
    preferences.fontFamily,
    preferences.theme,
    interactive,
  ]);

  // Outside position changes (bookmarks, Home/End, progress bar) map onto
  // the nearest spine section; engine-driven changes are skipped via the
  // reported-progress echo guard, mirroring the PDF reader's scroll-report
  // loop guard. Only actual position changes map back — the interactive
  // flip itself must not re-jump an engine that init has already positioned
  // (restored CFI or start). Before the first relocate there is no section
  // count to map onto.
  const previousPositionRef = useRef(0);
  useEffect(() => {
    if (!interactive || !handle) return;
    if (previousPositionRef.current === position) return;
    previousPositionRef.current = position;
    const reported = reportedFractionRef.current;
    if (reported !== null && Math.abs(position - reported * 100) < 0.5) return;
    const section = currentSectionRef.current;
    if (!section || section.total <= 0) return;
    const index = Math.min(
      section.total - 1,
      Math.max(0, Math.floor((position / 100) * section.total)),
    );
    void handle.goTo(index);
  }, [interactive, handle, position]);

  // Window-level page navigation; registered after the shell's handlers, so
  // while an EPUB is open these combos drive the engine, not percentage steps.
  useShortcut("arrowright", () => void handle?.next());
  useShortcut("space", () => void handle?.next());
  useShortcut("arrowleft", () => void handle?.prev());
  useShortcut("pagedown", () => void handle?.next());
  useShortcut("pageup", () => void handle?.prev());

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
  // persisted list (created in the tabs, deleted, recolored). The engine
  // re-adds a section's highlights whenever that section remounts, so this
  // only has to move the diff since the last commit.
  const drawnHighlightsRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!handle) return;
    const next = new Map<string, string>();
    for (const highlight of highlights) {
      if (highlight.cfi !== null) next.set(highlight.cfi, highlight.color ?? "");
    }
    for (const [cfi, color] of next) {
      if (drawnHighlightsRef.current.get(cfi) !== color) {
        handle.addHighlight(cfi, highlightCssColor(color));
      }
    }
    for (const cfi of drawnHighlightsRef.current.keys()) {
      if (!next.has(cfi)) handle.removeHighlight(cfi);
    }
    drawnHighlightsRef.current = next;
  }, [handle, highlights]);

  // The shell's selection toolbar drives highlight creation through this
  // controller; the reader owns the selection → CFI translation.
  const onCreateHighlightRef = useRef(onCreateHighlight);
  useEffect(() => {
    onCreateHighlightRef.current = onCreateHighlight;
  });

  // The shell adapter: one object covering jumps (TOC hrefs, bookmark and
  // search CFIs — the engine accepts both), search, and highlight creation.
  // Registered only while a handle is open, so a switched book can never be
  // driven through a stale engine.
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
                  cfi: match.cfi,
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
          const pending = pendingSelectionRef.current;
          if (!pending) return;
          const located = handle.getCfiFromRange(pending.doc, pending.range);
          pending.doc.getSelection()?.removeAllRanges();
          pendingSelectionRef.current = null;
          onSelectionChangeRef.current?.(null);
          if (!located) return;
          onCreateHighlightRef.current?.({
            kind: "highlight",
            cfi: located.cfi,
            chapterHref: located.href,
            text: pending.text,
            color: isHighlightColor(color) ? color : null,
          });
        },
        clearSelection: () => {
          const pending = pendingSelectionRef.current;
          if (pending) pending.doc.getSelection()?.removeAllRanges();
          pendingSelectionRef.current = null;
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

  return (
    <div
      data-testid="epub-reader"
      data-epub-state={interactive ? "ready" : "loading"}
      data-layout={preferences.layout}
      className="h-full"
    >
      {!interactive && (
        <p
          data-testid="epub-loading"
          className="px-6 py-8 text-center text-sm text-muted-foreground"
        >
          Loading {book.title}…
        </p>
      )}
      <div ref={containerRef} className="h-full" />
    </div>
  );
}

/**
 * Wait until the section document's fonts have settled (bounded), then run
 * `relayout` once. A no-op when the document exposes no FontFaceSet.
 */
function scheduleFontsSettledRelayout(doc: Document, relayout: () => void): void {
  const fonts = doc.fonts;
  if (!fonts) return;
  if (fonts.status === "loaded") {
    // One deferred pass covers layout that settles after the load event.
    window.setTimeout(relayout, 250);
    return;
  }
  let tries = 0;
  const poll = () => {
    if (fonts.status === "loaded" || tries >= 30) {
      relayout();
      return;
    }
    tries += 1;
    window.setTimeout(poll, 100);
  };
  window.setTimeout(poll, 100);
}

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
