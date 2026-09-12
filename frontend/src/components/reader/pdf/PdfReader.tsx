import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useShortcut } from "@/lib/shortcuts";
import { getPdfOutline, pdfWorkerSrc, type PdfOutlineItem } from "@/lib/pdf/pdfEngine";
import { useReader } from "@/state/readerState";
import { pdfThemeTreatment, pdfToolbarSurface } from "@/lib/pdf/theme";
import {
  isHighlightColor,
  highlightAtPoint,
  highlightForSelection,
  normalizeRect,
  type ReaderSelection,
} from "../annotationModel";
import {
  parsePdfProgress,
  pdfProgressPayload,
  type ReaderAdapter,
  type ReaderPosition,
} from "../readerModel";
import { useReaderProgress } from "../useReaderProgress";
import { PDF_PLACEHOLDER_PAGE_COUNT } from "../placeholderDocument";
import { useFitWidthScale } from "./hooks/useFitWidthScale";
import { usePdfDocument } from "./hooks/usePdfDocument";
import { usePdfGeometry } from "./hooks/usePdfGeometry";
import { usePdfSearch } from "./hooks/usePdfSearch";
import {
  READING_ANCHOR_RATIO,
  setScrollTop,
  usePdfScrollTracking,
  type PdfAnchorInfo,
} from "./hooks/usePdfScrollTracking";
import { usePdfVirtualization } from "./hooks/usePdfVirtualization";
import { PdfDocumentView } from "./PdfDocumentView";
import { PdfSidebar } from "./PdfSidebar";
import { PdfToolbar } from "./PdfToolbar";
import { PdfBitmapCache } from "./pdfBitmapCache";
import { pdfOpenState, pdfOpenTiming } from "./pdfOpenTelemetry";
import {
  MAX_ACTIVE_CANVAS_BYTES,
  capByBytes,
  effectiveRenderRatio,
  renderBufferBytes,
} from "./pdfRenderPolicy";
import { displayedSizes, layoutSlots } from "./pdfLayout";
import { pageToPosition, positionToPage } from "./pdfPages";
import type { ReaderSearchGroup } from "../searchModel";
import type { Annotation, AnnotationInput, AnnotationRect } from "@/types/domain";
import type { Book } from "@/types/domain";

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2] as const;
const DEFAULT_ZOOM_INDEX = 2;

/**
 * Count fallback for simultaneously active page canvases. The primary
 * render budget is bytes (MAX_ACTIVE_CANVAS_BYTES, pdfRenderPolicy) — at
 * reference 4K conditions only a few page-sized buffers fit, while at
 * smaller window sizes the byte budget is inert and this cap governs.
 */
const MAX_ACTIVE_CANVASES = 8;

/**
 * Upper bound on page renders started but not yet completed. MuPDF
 * rasterizes synchronously inside the document's worker, so renders
 * serialize there; two requests in flight keep the queue fed — page N+1 is
 * queued while page N rasterizes — instead of waiting for a fully drained
 * queue between pages. This keeps the page after a heavy cover from
 * starving: its render is already pending, not sent "after page 1
 * finishes".
 */
const MAX_CONCURRENT_RENDERS = 2;

interface PdfReaderProps {
  book: Book;
  /** Reports the real page count once the document has loaded. */
  onDocumentLoad?: (pageCount: number) => void;
  /** Reports the document outline (possibly empty) once it is resolved. */
  onOutlineLoad?: (outline: PdfOutlineItem[]) => void;
  /**
   * Host element for the thumbnails sidebar (owned by the shell's layout).
   * Null while the sidebar is closed or the book is not a PDF; the sidebar
   * renders through a portal so it can dock beside the scroll container
   * without scrolling with it, while this component stays the single owner
   * of the document handle.
   */
  sidebarHost?: HTMLElement | null;
  /** The reader's scroll container, owned by ReaderShell. */
  scrollContainerRef?: RefObject<HTMLElement | null>;
  /**
   * Filled with this reader's shell adapter while the document is loaded:
   * jump, search, and highlight creation. Nulled on unmount/book switch.
   */
  adapterRef?: { current: ReaderAdapter | null };
  /**
   * Reports the reading position (1-based page + anchor fraction) whenever
   * the page changes — the position a bookmark placed right now would keep.
   */
  onPositionChange?: (position: ReaderPosition) => void;
  /** Streams one page's worth of matches up to the shell. */
  onSearchGroup?: (bookId: number, group: ReaderSearchGroup) => void;
  /** Reports that the running search finished (for this book). */
  onSearchDone?: (bookId: number) => void;
  /** Highlights of the open book; drawn over rendered pages. */
  highlights?: Annotation[];
  /** Persists a highlight created from a text selection. */
  onCreateHighlight?: (input: AnnotationInput) => void;
  /**
   * Reports the current selection — or a plain click on an existing
   * highlight — with the highlight it targets, if any; null when nothing
   * is active.
   */
  onSelectionChange?: (selection: ReaderSelection | null) => void;
}

/**
 * PDF reading surface and the shell's PDF adapter: a continuous, vertically
 * scrolling document. The reading position owned by ReaderProvider is the
 * single source of truth — this component renders the document according to
 * that position and reports page changes back. Responsibilities live in the
 * pdf/ modules: document loading (usePdfDocument), geometry (usePdfGeometry
 * + pdfLayout), fit-width layout scale (useFitWidthScale), slot rendering
 * (PdfDocumentView/PdfPageSlot/PdfPageCanvas), toolbar state (PdfToolbar),
 * and the thumbnails sidebar (PdfSidebar, portaled into the shell's host).
 * Persistence runs through the shared useReaderProgress contract. The
 * outline comes from the engine seam and is reported upward for the
 * navigation drawer, and in-book search streams page text matches through
 * usePdfSearch.
 */
export function PdfReader({
  book,
  onDocumentLoad,
  onOutlineLoad,
  sidebarHost,
  scrollContainerRef,
  adapterRef,
  onPositionChange,
  onSearchGroup,
  onSearchDone,
  highlights = [],
  onCreateHighlight,
  onSelectionChange,
}: PdfReaderProps) {
  const { position, setPosition, preferences } = useReader();
  const {
    status,
    document: pdfDocument,
    pageCount,
    error,
    openMs,
    openStartedAt,
  } = usePdfDocument(book.id, onDocumentLoad);
  const { sizes, measurePages } = usePdfGeometry(pdfDocument, pageCount);
  const { registerSlot, visiblePages, preloadPages } = usePdfVirtualization();

  const [zoomIndex, setZoomIndex] = useState<number>(DEFAULT_ZOOM_INDEX);
  const [renderedPages, setRenderedPages] = useState<ReadonlySet<number>>(() => new Set());
  const [failedPages, setFailedPages] = useState<ReadonlySet<number>>(() => new Set());

  const zoom = ZOOM_LEVELS[zoomIndex] as number;
  const effectivePageCount = pageCount > 0 ? pageCount : PDF_PLACEHOLDER_PAGE_COUNT;
  const currentPage = positionToPage(position, effectivePageCount);
  const layoutReady = status === "ready" && sizes !== null;

  // Layout scale = fit-width base × user zoom multiplier (§ fit width).
  // The reference page is page 1; wider pages in mixed documents overflow
  // horizontally instead of shrinking the fit reference.
  const referencePageWidth = sizes?.[0]?.width ?? 0;
  const { scale: fitScale, contentAreaRef: registerContentArea } =
    useFitWidthScale(referencePageWidth);
  const scale = fitScale * zoom;

  // PERF-11 diagnostics (docs/PERFORMANCE.md): the reader publishes one
  // deterministic attribute snapshotting the geometry that drives every
  // raster budget — device pixel ratio, content width (the fit-width
  // input), viewport height, and the layout scale. It is refreshed when
  // the fit scale settles or changes (fit measurement lands an
  // effect-tick after mount) and is the baseline signal the 4K
  // investigation records; E2E may assert its shape, never a timing.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const contentAreaElementRef = useRef<HTMLDivElement | null>(null);
  const contentAreaRef = useCallback(
    (element: HTMLDivElement | null) => {
      contentAreaElementRef.current = element;
      registerContentArea(element);
    },
    [registerContentArea],
  );
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const area = contentAreaElementRef.current;
    const dpr = window.devicePixelRatio || 1;
    root.setAttribute(
      "data-pdf-render-info",
      `dpr:${dpr};w:${area?.clientWidth ?? 0};h:${window.innerHeight};scale:${Math.round(scale * 100) / 100}`,
    );
  }, [scale]);
  // The WebKitGTK version rides in the UA string; paired with the Rust
  // startup log of the GPU-stack env vars (lib.rs setup) this is the
  // environment record docs/research/performance-4k.md calls for.
  useEffect(() => {
    console.info(`[pdf] webview: ${navigator.userAgent}`);
  }, []);

  // Initialization sequence (§ lifecycle): DOCUMENT_READY → LAYOUT_READY →
  // POSITION_RESTORED → INTERACTIVE. The document surface renders only once
  // the saved position has been applied, so a reader never flashes page 1
  // before jumping to the restored location.
  const [restored, setRestored] = useState(false);
  // Open-timeline bookkeeping (docs/PERFORMANCE.md PDF-open telemetry): the
  // hook records the open anchor in its commit effect; the first rendered
  // page is "first useful page"; the interactive timestamp derives from the
  // restore callback below. All measurements happen in event callbacks or
  // pure derivations — never during render or in effects.
  const [firstPaintMs, setFirstPaintMs] = useState<number | null>(null);
  const [restoredAtMs, setRestoredAtMs] = useState<number | null>(null);
  const [firstPaintedPage, setFirstPaintedPage] = useState<number | null>(null);
  useReaderProgress<number>({
    bookId: book.id,
    enabled: layoutReady,
    current: currentPage,
    position,
    parseRestored: (record) => parsePdfProgress(record, effectivePageCount),
    onRestored: useCallback(
      (savedPage: number | null) => {
        if (savedPage !== null) {
          setPosition(pageToPosition(savedPage, effectivePageCount));
        }
        setRestored(true);
        setRestoredAtMs(performance.now() - (openStartedAt ?? performance.now()));
      },
      [effectivePageCount, openStartedAt, setPosition],
    ),
    savePayload: pdfProgressPayload,
  });
  const interactive = layoutReady && restored;

  // Outline resolution is engine-side (the document is already parsed);
  // failures degrade to an empty outline, never a reader error. The ref
  // indirection keeps the effect on the document alone, and the cancelled
  // flag stops a superseded load from reporting. Outline work is explicitly
  // below first paint (§ first-page priority): the request is sent only
  // after the first page has rendered, so it can never occupy the MuPDF
  // worker ahead of page 1. The ref guard keeps the one-shot behavior while
  // `hasFirstPaint` gates the effect.
  const onOutlineLoadRef = useRef(onOutlineLoad);
  useEffect(() => {
    onOutlineLoadRef.current = onOutlineLoad;
  });
  const hasFirstPaint = renderedPages.size > 0;
  const outlineDocumentRef = useRef<typeof pdfDocument>(null);
  useEffect(() => {
    if (!pdfDocument || !hasFirstPaint) return;
    if (outlineDocumentRef.current === pdfDocument) return;
    outlineDocumentRef.current = pdfDocument;
    let cancelled = false;
    getPdfOutline(pdfDocument)
      .then((outline) => {
        if (!cancelled) onOutlineLoadRef.current?.(outline);
      })
      .catch(() => {
        if (!cancelled) onOutlineLoadRef.current?.([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pdfDocument, hasFirstPaint]);

  // In-book search: extracts page text through the engine seam and streams
  // matches up to the shell. Consumed by the shell adapter below; a running
  // search is cancelled by unmount (book switch).
  const searchController = usePdfSearch({
    document: pdfDocument,
    bookId: book.id,
    onGroup: onSearchGroup ?? (() => {}),
    onDone: onSearchDone ?? (() => {}),
  });

  // Persisted highlights grouped by page, kept reachable for the selection
  // handler through a ref: the handler must resolve highlight overlap
  // against the live list without re-registering its listeners (which
  // would drop a pending selection mid-creation).
  const highlightsByPage = useMemo(() => {
    const byPage = new Map<number, Annotation[]>();
    for (const highlight of highlights) {
      if (highlight.pageNumber === null) continue;
      const list = byPage.get(highlight.pageNumber) ?? [];
      list.push(highlight);
      byPage.set(highlight.pageNumber, list);
    }
    return byPage;
  }, [highlights]);
  const highlightsByPageRef = useRef(highlightsByPage);
  useEffect(() => {
    highlightsByPageRef.current = highlightsByPage;
  });

  // Text selections on the text layers become highlight candidates. Page,
  // text, and normalized rects are all captured as soon as the selection
  // settles — a click on the toolbar's color swatch collapses the native
  // selection, so creation must not depend on it. Rects are normalized to
  // page space, which keeps them valid across later scroll and zoom. A
  // collapsed pointer (plain click) instead resolves the highlight under
  // the pointer, so the toolbar can recolor or remove an existing one.
  const pendingSelectionRef = useRef<{
    page: number;
    text: string;
    rects: AnnotationRect[];
  } | null>(null);
  const onSelectionChangeRef = useRef(onSelectionChange);
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
  });
  useEffect(() => {
    if (!pdfDocument) return;
    const readSelection = (event: Event) => {
      // Toolbar interactions must not clear the candidate they are about to
      // consume: the click's pointerdown collapses the native selection
      // before the button's click handler runs.
      if (
        event.target instanceof Element &&
        event.target.closest("[data-testid=selection-toolbar]")
      ) {
        return;
      }
      // The event's target and pointer position survive the deferral; the
      // selection itself must be read after it settles.
      const clickTarget = event.target instanceof Element ? event.target : null;
      const pointer = event as Partial<PointerEvent>;
      const clickX = typeof pointer.clientX === "number" ? pointer.clientX : 0;
      const clickY = typeof pointer.clientY === "number" ? pointer.clientY : 0;
      window.setTimeout(() => {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0 || !pdfDocument) {
          pendingSelectionRef.current = null;
          onSelectionChangeRef.current?.(null);
          return;
        }
        if (selection.isCollapsed) {
          // Plain click: address the existing highlight under the pointer,
          // if any, so the toolbar offers recolor and removal for it.
          pendingSelectionRef.current = null;
          const slot = clickTarget?.closest("[data-pdf-slot]") ?? null;
          const page = Number(slot?.getAttribute("data-pdf-slot"));
          const slotRect = slot?.getBoundingClientRect();
          const clicked =
            slot &&
            slotRect &&
            Number.isInteger(page) &&
            page >= 1 &&
            slotRect.width > 0 &&
            slotRect.height > 0
              ? highlightAtPoint(
                  highlightsByPageRef.current.get(page) ?? [],
                  page,
                  (clickX - slotRect.left) / slotRect.width,
                  (clickY - slotRect.top) / slotRect.height,
                )
              : null;
          onSelectionChangeRef.current?.(
            clicked === null ? null : { text: clicked.text ?? "", highlightId: clicked.id },
          );
          return;
        }
        const text = selection.toString().replace(/\s+/g, " ").trim();
        if (text === "") {
          pendingSelectionRef.current = null;
          onSelectionChangeRef.current?.(null);
          return;
        }
        const anchorNode = selection.anchorNode;
        const element =
          anchorNode instanceof Element ? anchorNode : (anchorNode?.parentElement ?? null);
        const slot = element?.closest("[data-pdf-slot]") ?? null;
        const page = Number(slot?.getAttribute("data-pdf-slot"));
        if (!slot || !Number.isInteger(page) || page < 1) {
          pendingSelectionRef.current = null;
          onSelectionChangeRef.current?.(null);
          return;
        }
        const slotRect = slot.getBoundingClientRect();
        const rects = Array.from(selection.getRangeAt(0).getClientRects())
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) =>
            normalizeRect(rect, slotRect.left, slotRect.top, slotRect.width, slotRect.height),
          )
          .filter((rect) => rect.width > 0 && rect.height > 0);
        if (rects.length === 0) {
          pendingSelectionRef.current = null;
          onSelectionChangeRef.current?.(null);
          return;
        }
        pendingSelectionRef.current = { page, text, rects };
        // Re-selecting highlighted text addresses that highlight (largest
        // overlap) instead of stacking a new one on top.
        const targeted = highlightForSelection(
          highlightsByPageRef.current.get(page) ?? [],
          page,
          rects,
        );
        onSelectionChangeRef.current?.({ text, highlightId: targeted?.id ?? null });
      }, 0);
    };
    document.addEventListener("pointerup", readSelection);
    return () => {
      document.removeEventListener("pointerup", readSelection);
      pendingSelectionRef.current = null;
    };
  }, [pdfDocument]);

  // The shell's selection toolbar drives highlight creation through this
  // controller; the reader owns the selection → normalized rects translation.
  const onCreateHighlightRef = useRef(onCreateHighlight);
  useEffect(() => {
    onCreateHighlightRef.current = onCreateHighlight;
  });

  // The shell adapter: one object covering jumps (pages/outlines/thumbnail
  // navigation all land in the same position model), search, and highlight
  // creation. Registered only while a document is loaded, so a switched
  // book can never be driven through a stale handle. `goToPage` closes over
  // the live page count through a ref, keeping the adapter stable.
  const goToPageRef = useRef<(page: number) => void>(() => {});
  useEffect(() => {
    if (!adapterRef) return;
    if (!pdfDocument) {
      adapterRef.current = null;
      return;
    }
    adapterRef.current = {
      jump: (target) => {
        if (target.format !== "pdf") return;
        goToPageRef.current(target.page);
      },
      search: searchController,
      annotations: {
        createHighlight: (color) => {
          const pending = pendingSelectionRef.current;
          if (!pending) return;
          window.getSelection()?.removeAllRanges();
          pendingSelectionRef.current = null;
          onSelectionChangeRef.current?.(null);
          onCreateHighlightRef.current?.({
            kind: "highlight",
            pageNumber: pending.page,
            rects: pending.rects,
            text: pending.text,
            color: isHighlightColor(color) ? color : null,
          });
        },
        clearSelection: () => {
          window.getSelection()?.removeAllRanges();
          pendingSelectionRef.current = null;
          onSelectionChangeRef.current?.(null);
        },
      },
    };
    return () => {
      adapterRef.current = null;
    };
  }, [adapterRef, pdfDocument, searchController]);

  const slots = useMemo(
    () => (sizes ? layoutSlots(displayedSizes(sizes, scale)) : []),
    [sizes, scale],
  );

  // Rendering policy, modeled on the classic viewer render queues,
  // adjusted for what the MuPDF worker actually parallelizes — see
  // MAX_CONCURRENT_RENDERS below:
  //
  //   1. up to MAX_CONCURRENT_RENDERS renders run at a time (started in
  //      priority order, completed/cancelled ones free their slot);
  //   2. the reading anchor page has absolute priority, then visible pages
  //      (closest first);
  //   3. exactly ONE prerender page beyond the viewport is attempted, and
  //      only while the concurrency budget has room to spare;
  //   4. a superseded in-flight render is simply unmounted (cancelled).
  //
  // Completed canvases stay mounted while their page remains inside the
  // virtualization window (anchor ∪ visible ∪ preload), bounded first by
  // the byte budget (MAX_ACTIVE_CANVAS_BYTES — at 4K only the closest few
  // page-sized buffers fit) and then by the MAX_ACTIVE_CANVASES count
  // fallback; on eviction the pixels move into the per-document bitmap
  // cache, so re-entry blits instead of re-rendering. Distant pages keep
  // only their geometry slots.
  const renderOrder = useMemo(() => {
    const active = [...new Set([currentPage, ...visiblePages])].sort(
      (a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage),
    );
    const preloaded = [...preloadPages]
      .sort((a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage))
      .find((page) => !active.includes(page));
    if (preloaded !== undefined) active.push(preloaded);
    // PERF-4: slice by each slot's capped buffer bytes (CSS size ×
    // effective ratio² × 4, Phase 1's policy) before the count fallback.
    // The anchor survives any budget (capByBytes keeps the first page).
    const slotsByPage = new Map(slots.map((slot) => [slot.pageNumber, slot]));
    const dpr = window.devicePixelRatio || 1;
    const bufferBytes = (page: number): number => {
      const slot = slotsByPage.get(page);
      if (!slot) return 0;
      const ratio = effectiveRenderRatio(slot.width / scale, slot.height / scale, scale, dpr);
      return renderBufferBytes(slot.width, slot.height, ratio);
    };
    return capByBytes(active, bufferBytes, MAX_ACTIVE_CANVAS_BYTES).slice(0, MAX_ACTIVE_CANVASES);
  }, [currentPage, visiblePages, preloadPages, slots, scale]);

  // The render set, derived purely from the priority order and the
  // completion/failure state: the first MAX_CONCURRENT_RENDERS unrendered
  // pages of `renderOrder` own canvases (bounded concurrency in flight —
  // they stay mounted until rendered, failed, or priority-demoted out of
  // the set, which cancels them), and completed canvases stay mounted while
  // their page remains in-window. A zoom clears `renderedPages`, so
  // in-place re-renders keep their canvas: the page is simply pending again
  // at priority rank 0. No mounted-set tracking is needed — the first-K
  // selection is idempotent across commits.
  const canvasPages = useMemo(() => {
    const window = new Set(renderOrder);
    const rendering: number[] = [];
    for (const page of renderOrder) {
      if (rendering.length >= MAX_CONCURRENT_RENDERS) break;
      if (renderedPages.has(page) || failedPages.has(page)) continue;
      rendering.push(page);
    }
    return [...[...renderedPages].filter((page) => window.has(page)), ...rendering];
  }, [renderOrder, renderedPages, failedPages]);

  // Per-document bitmap cache: eviction stashes finished buffers and window
  // re-entry blits them, so scrolling back across a heavy page never
  // re-pays its full raster. The cache participates in rendering (it is a
  // prop of every canvas), so it is state, reset whenever the document
  // instance changes — a switched book can never inherit the previous
  // book's pixels. The instance itself is a deliberately mutable box; only
  // its identity matters to React.
  const [cacheState, setCacheState] = useState<{
    document: typeof pdfDocument;
    cache: PdfBitmapCache;
  }>(() => ({ document: null, cache: new PdfBitmapCache() }));
  if (cacheState.document !== pdfDocument) {
    setCacheState({ document: pdfDocument, cache: new PdfBitmapCache() });
  }
  const bitmapCache = cacheState.cache;

  // Render bookkeeping is per-document too: stale "rendered" marks from a
  // previous document would let the next one bypass the concurrency budget,
  // and stale failures would hide pages. (ReaderShell remounts the reader
  // per book via `key`; this reset keeps the composition root honest even
  // without it.)
  const [bookkeepingDocument, setBookkeepingDocument] = useState<typeof pdfDocument>(null);
  if (bookkeepingDocument !== pdfDocument) {
    setBookkeepingDocument(pdfDocument);
    setRenderedPages(new Set());
    setFailedPages(new Set());
  }

  // Measure pages as they approach visibility so slot estimates become real
  // dimensions before their canvases render (lazy geometry correction).
  useEffect(() => {
    if (!layoutReady || (visiblePages.size === 0 && preloadPages.size === 0)) return;
    measurePages([...visiblePages, ...preloadPages]);
  }, [layoutReady, measurePages, visiblePages, preloadPages]);

  // Re-anchor after layout-scale changes (zoom multiplier, window resize,
  // fit-width recalculation): the anchor's page + in-page fraction — kept
  // current by the scroll tracker — is mapped onto the rescaled layout, so
  // the user keeps reading at the exact same spot (§ zoom preserves the
  // reading position) instead of falling back to the page's top edge.
  const activeSlotRef = useRef<HTMLDivElement | null>(null);
  const documentRef = useRef<HTMLDivElement | null>(null);
  const anchorInfoRef = useRef<PdfAnchorInfo | null>(null);

  // Position reporting to the shell: the page the reading anchor sits in,
  // with its in-page fraction at the time the page was entered (a coarse
  // page-local position is all a PDF bookmark keeps).
  const onPositionChangeRef = useRef(onPositionChange);
  useEffect(() => {
    onPositionChangeRef.current = onPositionChange;
  });
  useEffect(() => {
    onPositionChangeRef.current?.({
      format: "pdf",
      page: currentPage,
      fraction: anchorInfoRef.current?.fraction ?? 0,
    });
  }, [currentPage]);
  const scrollReportedPageRef = useRef<number | null>(null);
  const previousPageRef = useRef(currentPage);
  const previousScaleRef = useRef(scale);
  const mountedRef = useRef(false);

  const reanchorByFraction = useCallback(() => {
    const container = scrollContainerRef?.current ?? null;
    const documentEl = documentRef.current;
    const info = anchorInfoRef.current;
    if (!container || !documentEl || !info || slots.length === 0) {
      activeSlotRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
      return;
    }
    const slot = slots.find((candidate) => candidate.pageNumber === info.page) ?? slots[0];
    if (!slot) return;
    const targetAnchor = slot.top + info.fraction * slot.height;
    const documentTop =
      documentEl.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop;
    setScrollTop(
      container,
      targetAnchor + documentTop - container.clientHeight * READING_ANCHOR_RATIO,
    );
  }, [scrollContainerRef, slots]);

  // Keep the latest re-anchoring logic reachable from the effect below
  // without re-running that effect on every slots change (geometry
  // corrections must never yank the viewport).
  const reanchorRef = useRef<() => void>(() => {});
  useEffect(() => {
    reanchorRef.current = reanchorByFraction;
  });

  // The loop guard: a page change that *originated from scrolling* must not
  // scroll back. The scroll tracker stamps every page it reports; if the
  // observed change matches the last scroll report, it is the user's own
  // scroll and re-anchoring is skipped. Scale changes re-anchor by fraction.
  useEffect(() => {
    const pageChanged = previousPageRef.current !== currentPage;
    const scaleChanged = previousScaleRef.current !== scale;
    previousPageRef.current = currentPage;
    previousScaleRef.current = scale;

    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (pageChanged && !scaleChanged && scrollReportedPageRef.current === currentPage) {
      return;
    }
    if (scaleChanged) {
      reanchorRef.current();
      return;
    }
    activeSlotRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
  }, [currentPage, scale]);

  // Scroll-driven position reporting: the anchor rule decides the page, the
  // position is written back to ReaderProvider so the shell (footer, keyboard
  // stepping, pages drawer) stays consistent with what the user sees.
  const handleScrollPageChange = useCallback(
    (page: number) => {
      scrollReportedPageRef.current = page;
      setPosition(pageToPosition(page, effectivePageCount));
    },
    [effectivePageCount, setPosition],
  );
  usePdfScrollTracking({
    containerRef: scrollContainerRef ?? { current: null },
    documentRef,
    slots,
    enabled: layoutReady,
    onPageChange: handleScrollPageChange,
    anchorInfoRef,
  });

  const registerActiveSlot = useCallback((element: HTMLDivElement | null) => {
    activeSlotRef.current = element;
  }, []);

  const handlePageRendered = useCallback((pageNumber: number) => {
    setRenderedPages((current) => {
      if (current.has(pageNumber)) return current;
      const next = new Set(current);
      next.add(pageNumber);
      return next;
    });
  }, []);

  // Open-timeline measurement: the first rendered page is "first useful
  // page" (its timestamp lands here); restore time is captured in the
  // onRestored callback above.
  const handlePageRenderedTelemetried = useCallback(
    (pageNumber: number) => {
      setFirstPaintedPage((current) => current ?? pageNumber);
      setFirstPaintMs((current) => {
        if (current !== null) return current;
        return performance.now() - (openStartedAt ?? performance.now());
      });
      handlePageRendered(pageNumber);
    },
    [handlePageRendered, openStartedAt],
  );
  const interactiveMs = useMemo(() => {
    if (restoredAtMs === null || firstPaintMs === null) return null;
    return Math.max(restoredAtMs, firstPaintMs);
  }, [restoredAtMs, firstPaintMs]);

  // Deterministic PDF-open telemetry attributes (docs/PERFORMANCE.md):
  // state machine + compact timing string, present on every reader surface
  // (error, loading, interactive) so a stuck open names its own stage.
  const openState = pdfOpenState({
    status,
    hasDocument: pdfDocument !== null,
    layoutReady,
    restored,
    hasFirstPaint: renderedPages.size > 0,
  });
  const openTiming = pdfOpenTiming({
    bytes: "range",
    openMs,
    firstPaintMs,
    interactiveMs,
  });
  const openTelemetry = {
    "data-pdf-open-state": openState,
    "data-pdf-open-ms": openMs !== null ? String(Math.round(openMs)) : undefined,
    "data-pdf-first-paint-ms": firstPaintMs !== null ? String(Math.round(firstPaintMs)) : undefined,
    "data-pdf-first-page": firstPaintedPage !== null ? String(firstPaintedPage) : undefined,
    "data-pdf-open-timing": openTiming,
  } as const;

  const handlePageError = useCallback((pageNumber: number, renderError: unknown) => {
    setFailedPages((current) => {
      if (current.has(pageNumber)) return current;
      const next = new Set(current);
      next.add(pageNumber);
      return next;
    });
    console.error(`Failed to render PDF page ${pageNumber}`, renderError);
  }, []);

  // § page errors: a failed page shows a retryable error in its own slot;
  // the document itself stays usable. Clearing the failure makes the page
  // eligible for rendering again (highest priority first).
  const retryPage = useCallback((pageNumber: number) => {
    setFailedPages((current) => {
      if (!current.has(pageNumber)) return current;
      const next = new Set(current);
      next.delete(pageNumber);
      return next;
    });
  }, []);

  const goToPage = (page: number) => {
    const clamped = Math.max(1, Math.min(effectivePageCount, page));
    setPosition(pageToPosition(clamped, effectivePageCount));
  };
  // Keep the adapter's jump on the latest page count and position mapping.
  useEffect(() => {
    goToPageRef.current = goToPage;
  });

  // A zoom change invalidates rendered canvases; the new scale re-renders
  // the visible pages while evicted slots simply resize their reservations.
  // Cached bitmaps are keyed by scale, so they are dropped too.
  const changeZoom = (steps: number) => {
    setZoomIndex((index) => Math.max(0, Math.min(ZOOM_LEVELS.length - 1, index + steps)));
    setRenderedPages(new Set());
    setFailedPages(new Set());
    bitmapCache.clear();
  };

  // Keyboard zoom (§ reader keyboard): +/= in, - out. The shell does not
  // bind these, so there is no conflict with global reader shortcuts.
  const keyboardZoomRef = useRef<(steps: number) => void>(null);
  useEffect(() => {
    keyboardZoomRef.current = changeZoom;
  });
  useShortcut("+", () => keyboardZoomRef.current?.(1));
  useShortcut("=", () => keyboardZoomRef.current?.(1));
  useShortcut("-", () => keyboardZoomRef.current?.(-1));

  if (status === "error") {
    return (
      <div
        data-testid="pdf-reader"
        data-pdf-engine-state="error"
        {...openTelemetry}
        className="mx-auto max-w-3xl px-6 py-8"
      >
        <p
          data-testid="pdf-error"
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
        >
          This PDF could not be opened: {error}
        </p>
      </div>
    );
  }

  if (!interactive || !pdfDocument) {
    return (
      <div
        data-testid="pdf-reader"
        // Engine lifecycle as a deterministic attribute (docs/PDF.md): a
        // stuck or failed stage names itself instead of leaving the tests to
        // infer from a missing reader. status "ready" means the document is
        // parsed (worker/document path); layout follows once sizes are known.
        data-pdf-engine-state={
          layoutReady ? "layout-ready" : status === "ready" ? "document-parsed" : "document-loading"
        }
        {...openTelemetry}
        className="mx-auto max-w-3xl px-6 py-8"
      >
        <p data-testid="pdf-loading" className="text-center text-sm text-muted-foreground">
          Loading {book.title}…
        </p>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-testid="pdf-reader"
      data-pdf-engine-state="interactive"
      data-pdf-worker-src={pdfWorkerSrc()}
      data-pdf-bitmap-cache={`${bitmapCache.size}:${bitmapCache.byteSize}`}
      {...openTelemetry}
      className="flex flex-col items-stretch px-6 py-4"
    >
      <PdfToolbar
        pageNumber={currentPage}
        pageCount={effectivePageCount}
        zoomPercent={Math.round(zoom * 100)}
        canZoomIn={zoomIndex < ZOOM_LEVELS.length - 1}
        canZoomOut={zoomIndex > 0}
        surfaceColor={pdfToolbarSurface(preferences.theme)}
        onPrev={() => goToPage(currentPage - 1)}
        onNext={() => goToPage(currentPage + 1)}
        onZoomIn={() => changeZoom(1)}
        onZoomOut={() => changeZoom(-1)}
      />
      <PdfDocumentView
        document={pdfDocument}
        slots={slots}
        renderPages={canvasPages}
        anchorPage={currentPage}
        scale={scale}
        renderedPages={renderedPages}
        failedPages={failedPages}
        bitmapCache={bitmapCache}
        previewAnchorRender={renderedPages.size === 0}
        onPageRendered={handlePageRenderedTelemetried}
        onPageError={handlePageError}
        registerSlot={registerSlot}
        registerAnchorSlot={registerActiveSlot}
        documentRef={documentRef}
        contentAreaRef={contentAreaRef}
        onRetryPage={retryPage}
        highlightsByPage={highlightsByPage}
        themeFilter={pdfThemeTreatment(preferences.theme).filter}
        themeTint={pdfThemeTreatment(preferences.theme).tint}
      />
      {sidebarHost &&
        createPortal(
          <PdfSidebar
            document={pdfDocument}
            sizes={sizes}
            currentPage={currentPage}
            measurePages={measurePages}
            onNavigate={goToPage}
          />,
          sidebarHost,
        )}
    </div>
  );
}
