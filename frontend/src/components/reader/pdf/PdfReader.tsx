import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useShortcut } from "@/lib/shortcuts";
import { getPdfOutline, pdfWorkerSrc, type PdfOutlineItem } from "@/lib/pdf/pdfEngine";
import { useReader } from "@/state/readerState";
import { pdfThemeTreatment } from "@/lib/pdf/theme";
import {
  highlightAtPoint,
  highlightForSelection,
  normalizeRect,
  type ReaderSelection,
} from "../annotationModel";
import { isHighlightColor, readerThemeFamily } from "@/lib/highlightPalette";
import {
  parsePdfProgress,
  pdfProgressPayload,
  type ReaderAdapter,
  type ReaderJump,
  type ReaderPosition,
} from "../readerModel";
import { useReaderProgress } from "../useReaderProgress";
import { PDF_PLACEHOLDER_PAGE_COUNT } from "../placeholderDocument";
import { usePdfBookPreload } from "./hooks/usePdfBookPreload";
import { usePdfDocument } from "./hooks/usePdfDocument";
import { usePdfGeometry } from "./hooks/usePdfGeometry";
import {
  usePdfPresentationPreload,
  type PdfPreloadRequest,
} from "./hooks/usePdfPresentationPreload";
import { usePdfScale } from "./hooks/usePdfScale";
import { usePdfSearch } from "./hooks/usePdfSearch";
import {
  setScrollLeft,
  setScrollTop,
  usePdfScrollTracking,
  type PdfAnchorInfo,
} from "./hooks/usePdfScrollTracking";
import { usePdfViewport, type PdfViewport } from "./hooks/usePdfViewport";
import { usePdfZoomTelemetry } from "./hooks/usePdfZoomTelemetry";
import { usePdfVirtualization } from "./hooks/usePdfVirtualization";
import { PdfBookView } from "./PdfBookView";
import type { PdfBookTurnAdapter } from "./pdfBookTurn";
import { PdfDocumentView } from "./PdfDocumentView";
import { PdfPresentationBar } from "./PdfPresentationBar";
import { PdfSidebar } from "./PdfSidebar";
import { PdfToolbar } from "./PdfToolbar";
import { PdfBitmapCache } from "./pdfBitmapCache";
import { pdfOpenState, pdfOpenTiming } from "./pdfOpenTelemetry";
import {
  MAX_ACTIVE_CANVAS_BYTES,
  capByBytes,
  effectiveRenderRatio,
  renderBufferBytes,
  retentionRing,
} from "./pdfRenderPolicy";
import {
  adjustmentValueForPolicy,
  centerValue,
  clampZoom,
  DEFAULT_ZOOM_LEVEL,
  MAX_ZOOM,
  MIN_ZOOM,
  displayedSizes,
  documentHeight,
  documentMaxPageSize,
  keepPositionValue,
  layoutSlots,
  layoutSpread,
  PAGE_GAP_PX,
  spreadNeighbourPageIndexes,
  stepZoomLevel,
  visiblePageRegion,
  wheelZoomScale,
  type FitZoomMode,
  type LayoutSlot,
  type Rect,
  type ScrollAdjustment,
  type ZoomMode,
} from "./pdfLayout";
import { clampPage, pageToPosition, positionToPage } from "./pdfPages";
import type { ReaderSearchGroup } from "../searchModel";
import type { Annotation, AnnotationInput, AnnotationRect } from "@/types/domain";
import type { Book } from "@/types/domain";

/**
 * Zoom state (issue #65): a mode plus, for `custom`, the absolute ladder
 * level (1 = 100%). The fit modes are dynamic — the layout scale is
 * recomputed from the measured viewport whenever it changes — while custom
 * pins the scale until the user zooms again.
 */
interface ZoomState {
  mode: ZoomMode;
  level: number;
}

const DEFAULT_ZOOM_STATE: ZoomState = { mode: "fit-width", level: DEFAULT_ZOOM_LEVEL };

/**
 * Count fallback for simultaneously active page canvases. The primary
 * render budget is bytes (MAX_ACTIVE_CANVAS_BYTES, pdfRenderPolicy) — at
 * reference 4K conditions only a few page-sized buffers fit, while at
 * smaller window sizes the byte budget is inert and this cap governs.
 */
const MAX_ACTIVE_CANVASES = 8;

/**
 * Upper bound on page renders started but not yet completed. PDFium
 * rasterizes synchronously inside the document's worker, so renders
 * serialize there; two requests in flight keep the queue fed — page N+1 is
 * queued while page N rasterizes — instead of waiting for a fully drained
 * queue between pages. This keeps the page after a heavy cover from
 * starving: its render is already pending, not sent "after page 1
 * finishes".
 */
const MAX_CONCURRENT_RENDERS = 2;

/**
 * Quiet period that ends a Ctrl+wheel zoom gesture (issue: smooth wheel
 * zoom): the expensive relayout + sharp redraw commits this long after the
 * last wheel event. pdf.js uses 400ms; meanwhile the page stays visible
 * under a CSS-transform preview, so nothing re-renders mid-gesture.
 */
const WHEEL_SETTLE_MS = 250;

/**
 * Inert stand-in for the zoom handlers while book mode is on (spec →
 * Zoom): the spread is fit-the-pair only, so every keyboard zoom entry
 * point no-ops instead of mutating scroll-view zoom invisibly — a stray
 * Ctrl+- would change the zoom the reader restores when the mode turns
 * off.
 */
function inertZoom(): void {}

/**
 * The transient wheel-gesture preview: an absolute scale (like a custom
 * zoom level) plus the transform origin — the cursor point, in committed
 * layout pixels local to the document element. Rendered while the gesture
 * is active; the committed layout scale does not change until settle.
 */
interface WheelPreview {
  scale: number;
  originX: number;
  originY: number;
}

/**
 * Everything the gesture needs to commit, kept beside the rendered preview:
 * the last cursor position (viewport coordinates) and where the document
 * element sat in scroll content when the gesture began. Layout and scroll
 * stay put for the whole gesture, because every Ctrl+wheel event is
 * prevented, so the captured geometry stays valid until settle.
 */
interface WheelGesture extends WheelPreview {
  epoch: number;
  clientX: number;
  clientY: number;
  docLeft: number;
  docTop: number;
  /** Committed content size, to tell a scrollable axis from a fitting one. */
  docWidth: number;
  docHeight: number;
}

/**
 * Region rasterization (high zoom): rasterize a margin beyond the visible
 * area so scrolling does not immediately run past the painted region, and
 * snap region edges to a grid so sub-step scrolling reuses the same region
 * key. Both in page-local CSS pixels, which are 1:1 with screen pixels.
 *
 * A region raster is expensive on a vector-heavy page (hundreds of
 * milliseconds to seconds at device resolution), so a zoom must keep the
 * previous bitmap on screen through the change; see the scale-and-swap remap
 * in `PdfPageCanvas`.
 */
const REGION_OVERSCAN_PX = 768;
const REGION_STEP_PX = 256;
/** How many recent scroll-reported pages the re-anchor loop guard remembers. */
const SCROLL_REPORT_MEMORY = 64;

/** Per-page visible regions for the current viewport, with an overscan margin. */
function visiblePageRegions(
  viewport: PdfViewport,
  slots: LayoutSlot[],
  documentWidth: number,
  overscanPx: number,
): Map<number, Rect> {
  const frame: Rect = {
    top: viewport.scrollTop,
    left: viewport.scrollLeft,
    width: viewport.width,
    height: viewport.height,
  };
  const regions = new Map<number, Rect>();
  for (const slot of slots) {
    const region = visiblePageRegion(
      {
        top: viewport.documentTop + slot.top,
        left: viewport.documentLeft + (documentWidth - slot.width) / 2,
        width: slot.width,
        height: slot.height,
      },
      frame,
      overscanPx,
      REGION_STEP_PX,
    );
    if (region) regions.set(slot.pageNumber, region);
  }
  return regions;
}

/**
 * A settled selection's outcome (issue: the pointerup handler defers by a
 * tick, then classifies): `cleared` resets the pending candidate, `click`
 * addresses an existing highlight under a collapsed pointer, `select`
 * carries a fresh text-selection candidate.
 */
type SettledSelection =
  | { kind: "cleared" }
  | { kind: "click"; text: string; highlightId: Annotation["id"] }
  | {
      kind: "select";
      page: number;
      text: string;
      rects: AnnotationRect[];
      highlightId: Annotation["id"] | null;
    };

/** The page slot a DOM node belongs to, with its element; null outside one. */
function slotOf(node: Node | null): { page: number; slot: Element } | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null);
  const slot = element?.closest("[data-pdf-slot]") ?? null;
  const page = Number(slot?.getAttribute("data-pdf-slot"));
  return slot && Number.isInteger(page) && page >= 1 ? { page, slot } : null;
}

/** The highlight under a collapsed pointer (plain click), if any. */
function highlightAtClick(input: {
  highlightsByPage: Map<number, Annotation[]>;
  clickTarget: Element | null;
  clickX: number;
  clickY: number;
}): Annotation | null {
  const found = slotOf(input.clickTarget);
  const slotRect = found?.slot.getBoundingClientRect();
  return found && slotRect && slotRect.width > 0 && slotRect.height > 0
    ? highlightAtPoint(
        input.highlightsByPage.get(found.page) ?? [],
        found.page,
        (input.clickX - slotRect.left) / slotRect.width,
        (input.clickY - slotRect.top) / slotRect.height,
      )
    : null;
}

/** Selection rects normalized to the slot's page space, drops-empty. */
function rectsFromSelection(selection: Selection, slot: Element): AnnotationRect[] {
  const slotRect = slot.getBoundingClientRect();
  return Array.from(selection.getRangeAt(0).getClientRects())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) =>
      normalizeRect(rect, slotRect.left, slotRect.top, slotRect.width, slotRect.height),
    )
    .filter((rect) => rect.width > 0 && rect.height > 0);
}

/**
 * Classify a settled selection: a collapsed pointer resolves the highlight
 * under it (so the toolbar can recolor or remove it), a text selection
 * becomes a highlight candidate targeting the largest-overlap highlight.
 */
function resolveSettledSelection(
  selection: Selection | null,
  hasDocument: boolean,
  input: {
    highlightsByPage: Map<number, Annotation[]>;
    clickTarget: Element | null;
    clickX: number;
    clickY: number;
  },
): SettledSelection {
  if (!selection || selection.rangeCount === 0 || !hasDocument) {
    return { kind: "cleared" };
  }
  if (selection.isCollapsed) {
    const clicked = highlightAtClick(input);
    return clicked === null
      ? { kind: "cleared" }
      : { kind: "click", text: clicked.text ?? "", highlightId: clicked.id };
  }
  const text = selection.toString().replace(/\s+/g, " ").trim();
  const found = text === "" ? null : slotOf(selection.anchorNode);
  if (!found) {
    return { kind: "cleared" };
  }
  const rects = rectsFromSelection(selection, found.slot);
  if (rects.length === 0) {
    return { kind: "cleared" };
  }
  const targeted = highlightForSelection(
    input.highlightsByPage.get(found.page) ?? [],
    found.page,
    rects,
  );
  return { kind: "select", page: found.page, text, rects, highlightId: targeted?.id ?? null };
}

export interface PdfReaderProps {
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
  /**
   * Host element for the document controls (PdfToolbar: page navigation +
   * zoom), a header slot owned by ReaderShell's layout. The controls dock
   * through a portal so the dedicated control row above the document is
   * gone and its vertical space goes to the pages (issue #68), while this
   * component stays the single owner of the zoom and position state. Null
   * while the shell provides no host (standalone renders, e.g. unit
   * tests); the controls then fall back to rendering inline above the
   * document.
   */
  controlsHost?: HTMLElement | null;
  /** The reader's scroll container, owned by ReaderShell. */
  scrollContainerRef?: RefObject<HTMLElement | null>;
  /**
   * Filled with this reader's shell adapter while the document is loaded:
   * jump, search, and highlight creation. Nulled on unmount/book switch.
   */
  adapterRef?: { current: ReaderAdapter | null };
  /**
   * Filled with the open book view's turn adapter (tuxbooks-9pr.5) so the
   * shell's keyboard steps spreads through the same instance the view's
   * edge/corner zones call; nulled when the book view unmounts.
   */
  bookTurnRef?: { current: PdfBookTurnAdapter | null };
  /**
   * Initial destination for a reader opened from a highlight. Applied as
   * part of the restore so the saved position cannot overwrite it.
   */
  initialJump?: ReaderJump | null;
  /**
   * Reports the reading position (1-based page + anchor fraction) whenever
   * the page changes — the position a bookmark placed right now would keep.
   */
  onPositionChange?: (position: ReaderPosition) => void;
  /** Streams one page's worth of matches up to the shell. */
  onSearchGroup?: (bookId: number, group: ReaderSearchGroup) => void;
  /** Reports that the running search finished (for this book). */
  onSearchDone?: (bookId: number, truncated: boolean) => void;
  /** Highlights of the open book; drawn over rendered pages. */
  highlights?: Annotation[];
  /**
   * Presentation mode (issue #65): fullscreen, distraction-free, one page
   * at a time at a dynamic fit-page scale. The shell owns the toggle
   * (Ctrl+L), the chrome hiding, and the fullscreen request; this
   * component rescales the document and swaps the controls.
   */
  presentationMode?: boolean;
  /** Exits presentation mode (the in-mode exit control). */
  onExitPresentation?: () => void;
  /** Toggles presentation mode (the toolbar's in-header control). */
  onTogglePresentation?: () => void;
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
 * + pdfLayout), zoom modes and the derived layout scale (usePdfScale),
 * slot rendering (PdfDocumentView/PdfPageSlot/PdfPageCanvas), document
 * controls docked into the shell's header (PdfToolbar, portaled), the
 * presentation-mode bar (PdfPresentationBar), and the thumbnails sidebar
 * (PdfSidebar, portaled into the shell's host).
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
  controlsHost,
  scrollContainerRef,
  adapterRef,
  bookTurnRef,
  initialJump,
  onPositionChange,
  onSearchGroup,
  onSearchDone,
  highlights = [],
  presentationMode = false,
  onExitPresentation,
  onTogglePresentation,
  onCreateHighlight,
  onSelectionChange,
}: PdfReaderProps) {
  const { position, setPosition, preferences, effectiveTheme } = useReader();
  const {
    status,
    document: pdfDocument,
    pageCount,
    error,
    openMs,
    openStartedAt,
  } = usePdfDocument(book.id, onDocumentLoad);
  // Below-first-paint work gates on this: measurement and the outline request must never queue ahead of page 1.
  const [firstPainted, setFirstPainted] = useState(false);
  const { sizes, measurePages, isMeasured } = usePdfGeometry(pdfDocument, pageCount, firstPainted);
  const { registerSlot, visiblePages, preloadPages } = usePdfVirtualization();
  // Captured at mount: the shell clears the app-state target once annotations resolve.
  const initialJumpRef = useRef(initialJump);

  const treatment = pdfThemeTreatment(effectiveTheme);
  const renderVariant = treatment.smart ? "smart" : "original";

  const [zoom, setZoom] = useState<ZoomState>(DEFAULT_ZOOM_STATE);
  const [renderedPages, setRenderedPages] = useState<ReadonlySet<number>>(() => new Set());
  const [failedPages, setFailedPages] = useState<ReadonlySet<number>>(() => new Set());
  const [preloadCount, setPreloadCount] = useState(0);
  // Scale-and-swap pages kept for display only; reset on document, variant, or presentation flip, not on zoom.
  const [stalePages, setStalePages] = useState<ReadonlySet<number>>(() => new Set());
  const renderedPagesRef = useRef(renderedPages);
  useEffect(() => {
    renderedPagesRef.current = renderedPages;
  });

  const effectivePageCount = pageCount > 0 ? pageCount : PDF_PLACEHOLDER_PAGE_COUNT;
  const currentPage = positionToPage(position, effectivePageCount);
  const layoutReady = status === "ready" && sizes !== null;
  const dpr = window.devicePixelRatio || 1;

  const referencePage = useMemo(() => (sizes ? documentMaxPageSize(sizes) : null), [sizes]);
  const presentationPage = presentationMode && sizes ? (sizes[currentPage - 1] ?? null) : null;
  const scaleRequest = useMemo(
    () => ({
      mode: zoom.mode,
      level: zoom.level,
      reference: referencePage,
      presentationPage,
    }),
    [zoom.mode, zoom.level, referencePage, presentationPage],
  );
  const {
    scale,
    contentAreaRef: registerContentArea,
    areaWidth,
    viewportHeight,
  } = usePdfScale(scaleRequest, scrollContainerRef);

  const preloadRequest = useMemo<PdfPreloadRequest>(
    () => ({ mode: zoom.mode, level: zoom.level, reference: referencePage }),
    [zoom.mode, zoom.level, referencePage],
  );

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
  useEffect(() => {
    console.info(`[pdf] webview: ${navigator.userAgent}`);
  }, []);

  const [restored, setRestored] = useState(false);
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
        const targetPage =
          initialJumpRef.current?.format === "pdf" ? initialJumpRef.current.page : null;
        const page = targetPage === null ? savedPage : clampPage(targetPage, effectivePageCount);
        if (page !== null) {
          setPosition(pageToPosition(page, effectivePageCount));
        }
        setRestored(true);
        setRestoredAtMs(performance.now() - (openStartedAt ?? performance.now()));
      },
      [effectivePageCount, openStartedAt, setPosition],
    ),
    savePayload: pdfProgressPayload,
  });
  const interactive = layoutReady && restored;

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

  const searchController = usePdfSearch({
    document: pdfDocument,
    bookId: book.id,
    onGroup: onSearchGroup ?? (() => {}),
    onDone: onSearchDone ?? (() => {}),
  });

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
      // Toolbar pointerdown collapses the native selection before its click handler runs.
      if (
        event.target instanceof Element &&
        event.target.closest("[data-testid=selection-toolbar]")
      ) {
        return;
      }
      const clickTarget = event.target instanceof Element ? event.target : null;
      const pointer = event as Partial<PointerEvent>;
      const clickX = typeof pointer.clientX === "number" ? pointer.clientX : 0;
      const clickY = typeof pointer.clientY === "number" ? pointer.clientY : 0;
      window.setTimeout(() => {
        const resolution = resolveSettledSelection(window.getSelection(), pdfDocument !== null, {
          highlightsByPage: highlightsByPageRef.current,
          clickTarget,
          clickX,
          clickY,
        });
        if (resolution.kind === "select") {
          pendingSelectionRef.current = {
            page: resolution.page,
            text: resolution.text,
            rects: resolution.rects,
          };
        } else {
          pendingSelectionRef.current = null;
        }
        onSelectionChangeRef.current?.(
          resolution.kind === "cleared"
            ? null
            : { text: resolution.text, highlightId: resolution.highlightId },
        );
      }, 0);
    };
    document.addEventListener("pointerup", readSelection);
    return () => {
      document.removeEventListener("pointerup", readSelection);
      pendingSelectionRef.current = null;
    };
  }, [pdfDocument]);

  const onCreateHighlightRef = useRef(onCreateHighlight);
  useEffect(() => {
    onCreateHighlightRef.current = onCreateHighlight;
  });

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
  const slotsRef = useRef(slots);
  useEffect(() => {
    slotsRef.current = slots;
  });

  const documentSlots = useMemo(
    () => (presentationMode ? slots.filter((slot) => slot.pageNumber === currentPage) : slots),
    [presentationMode, slots, currentPage],
  );

  const bufferBytes = useMemo(() => {
    const slotsByPage = new Map(documentSlots.map((slot) => [slot.pageNumber, slot]));
    return (page: number): number => {
      const slot = slotsByPage.get(page);
      if (!slot) return 0;
      const ratio = effectiveRenderRatio(slot.width / scale, slot.height / scale, scale, dpr);
      return renderBufferBytes(slot.width, slot.height, ratio);
    };
  }, [documentSlots, scale, dpr]);

  const renderOrder = useMemo(() => {
    const active = [...new Set([currentPage, ...visiblePages])].sort(
      (a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage),
    );
    const preloaded = [...preloadPages]
      .sort((a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage))
      .find((page) => !active.includes(page));
    if (preloaded !== undefined) active.push(preloaded);
    return capByBytes(active, bufferBytes, MAX_ACTIVE_CANVAS_BYTES).slice(0, MAX_ACTIVE_CANVASES);
  }, [currentPage, visiblePages, preloadPages, bufferBytes]);

  const { canvasPages, renderPermittedPages } = useMemo(() => {
    // The ring only decides what stays mounted; it never adds a page to renderPermittedPages.
    const window = new Set(renderOrder);
    const retained = retentionRing(
      visiblePages,
      [...renderedPages, ...stalePages].filter((page) => !window.has(page)),
    );
    const mountWindow = new Set(
      capByBytes([...renderOrder, ...retained], bufferBytes, MAX_ACTIVE_CANVAS_BYTES).slice(
        0,
        MAX_ACTIVE_CANVASES,
      ),
    );
    const rendering: number[] = [];
    for (const page of renderOrder) {
      if (rendering.length >= MAX_CONCURRENT_RENDERS) break;
      if (renderedPages.has(page) || failedPages.has(page)) continue;
      rendering.push(page);
    }
    const mounted = new Set<number>();
    for (const page of renderedPages) if (mountWindow.has(page)) mounted.add(page);
    for (const page of stalePages) if (mountWindow.has(page)) mounted.add(page);
    for (const page of rendering) mounted.add(page);
    return { canvasPages: [...mounted], renderPermittedPages: new Set(rendering) };
  }, [renderOrder, renderedPages, failedPages, stalePages, visiblePages, bufferBytes]);

  const [cacheState, setCacheState] = useState<{
    document: typeof pdfDocument;
    cache: PdfBitmapCache;
  }>(() => ({ document: null, cache: new PdfBitmapCache() }));
  if (cacheState.document !== pdfDocument) {
    setCacheState({ document: pdfDocument, cache: new PdfBitmapCache() });
  }
  const bitmapCache = cacheState.cache;

  const [bookkeepingDocument, setBookkeepingDocument] = useState<typeof pdfDocument>(null);
  if (bookkeepingDocument !== pdfDocument) {
    setBookkeepingDocument(pdfDocument);
    setRenderedPages(new Set());
    setFailedPages(new Set());
    setStalePages(new Set());
  }

  const [variantState, setVariantState] = useState<{
    variant: string;
    document: typeof pdfDocument;
  }>(() => ({ variant: renderVariant, document: pdfDocument }));
  if (variantState.variant !== renderVariant || variantState.document !== pdfDocument) {
    setVariantState({ variant: renderVariant, document: pdfDocument });
    setRenderedPages(new Set());
    setFailedPages(new Set());
    setStalePages(new Set());
    setCacheState({ document: pdfDocument, cache: new PdfBitmapCache() });
  }

  useEffect(() => {
    if (!layoutReady || (visiblePages.size === 0 && preloadPages.size === 0)) return;
    measurePages([...visiblePages, ...preloadPages]);
  }, [layoutReady, measurePages, visiblePages, preloadPages]);

  useEffect(() => {
    if (!presentationMode || !layoutReady) return;
    const neighbours = [currentPage - 1, currentPage + 1].filter(
      (page) => page >= 1 && page <= effectivePageCount,
    );
    if (neighbours.length > 0) measurePages(neighbours);
  }, [presentationMode, layoutReady, currentPage, effectivePageCount, measurePages]);

  const handlePreloaded = useCallback(() => {
    setPreloadCount((count) => count + 1);
  }, []);
  usePdfPresentationPreload({
    document: pdfDocument,
    sizes,
    currentPage,
    pageCount: effectivePageCount,
    enabled: presentationMode,
    request: preloadRequest,
    currentPageReady: renderedPages.has(currentPage),
    isMeasured,
    areaWidth,
    viewportHeight,
    bitmapCache,
    smartColors: treatment.smart,
    renderVariant,
    dpr,
    onPreloaded: handlePreloaded,
  });

  // Scroll-view-only controls and effects gate on this so a hidden control cannot mutate the state the mode restores.
  const bookMode = preferences.bookMode && !presentationMode;

  useEffect(() => {
    if (!bookMode || !layoutReady || !sizes) return;
    const pageIndex = Math.max(0, currentPage - 1);
    const pages = spreadNeighbourPageIndexes(pageIndex, effectivePageCount).flatMap(
      (index) => layoutSpread(sizes, index)?.pages.map((page) => page.pageNumber) ?? [],
    );
    if (pages.length > 0) measurePages(pages);
  }, [bookMode, layoutReady, sizes, currentPage, effectivePageCount, measurePages]);

  usePdfBookPreload({
    document: pdfDocument,
    sizes,
    currentPage,
    pageCount: effectivePageCount,
    enabled: bookMode,
    areaWidth,
    viewportHeight,
    isMeasured,
    bitmapCache,
    smartColors: treatment.smart,
    renderVariant,
    dpr,
    onPreloaded: handlePreloaded,
  });

  const activeSlotRef = useRef<HTMLDivElement | null>(null);
  const documentRef = useRef<HTMLDivElement | null>(null);
  const anchorInfoRef = useRef<PdfAnchorInfo | null>(null);

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
  // A set of recent scroll reports, not just the last: React commits currentPage a frame
  // or two late, so a stale commit would scrollIntoView back mid-drag and oscillate.
  const scrollReportedPagesRef = useRef<{ set: Set<number>; queue: number[] }>({
    set: new Set(),
    queue: [],
  });
  const previousPageRef = useRef(currentPage);
  const previousScaleRef = useRef(scale);
  const previousPresentationRef = useRef(presentationMode);
  const previousBookRef = useRef(bookMode);
  const previousSlotsRef = useRef(slots);
  const mountedRef = useRef(false);

  const applyZoom = useCallback(
    (next: ZoomState) => {
      setZoom(next);
      setStalePages((current) => new Set([...current, ...renderedPagesRef.current]));
      setRenderedPages(new Set());
      setFailedPages(new Set());
      bitmapCache.clear();
    },
    [bitmapCache],
  );

  const [wheelPreview, setWheelPreview] = useState<WheelPreview | null>(null);
  // Bumped by non-gesture zoom changes; a pre-bump gesture's settle commit must be discarded.
  const [zoomEpoch, setZoomEpoch] = useState(0);
  const wheelGestureRef = useRef<WheelGesture | null>(null);
  const wheelSettleRef = useRef<number | null>(null);
  const wheelScrollFixupRef = useRef<{
    targetScale: number;
    oldValueX: number;
    oldValueY: number;
    oldUpperX: number;
    oldUpperY: number;
    viewportWidth: number;
    viewportHeight: number;
    centerX: number;
    centerY: number;
    applied: boolean;
  } | null>(null);
  const committedScaleRef = useRef(scale);
  const zoomEpochRef = useRef(zoomEpoch);
  const zoomTriggerRef = useRef("");
  const zoomPointerRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    committedScaleRef.current = scale;
  });
  useEffect(() => {
    zoomEpochRef.current = zoomEpoch;
  });

  const clearWheelSettle = useCallback(() => {
    if (wheelSettleRef.current !== null) {
      window.clearTimeout(wheelSettleRef.current);
      wheelSettleRef.current = null;
    }
  }, []);

  const cancelWheelGesture = useCallback(() => {
    clearWheelSettle();
    wheelGestureRef.current = null;
    setWheelPreview(null);
  }, [clearWheelSettle]);

  const commitWheelGesture = useCallback(() => {
    const gesture = wheelGestureRef.current;
    if (!gesture) return;
    clearWheelSettle();
    wheelGestureRef.current = null;
    setWheelPreview(null);
    if (gesture.epoch !== zoomEpochRef.current) return;
    const committed = committedScaleRef.current;
    if (gesture.scale === committed) return;
    const container = scrollContainerRef?.current ?? null;
    if (container) {
      const containerRect = container.getBoundingClientRect();
      const oldSlots = slotsRef.current;
      const oldDocWidth = oldSlots.reduce((max, slot) => Math.max(max, slot.width), 0);
      const viewportWidth = container.clientWidth;
      const viewportHeight = container.clientHeight;
      wheelScrollFixupRef.current = {
        targetScale: gesture.scale,
        oldValueX: container.scrollLeft - gesture.docLeft,
        oldValueY: container.scrollTop - gesture.docTop,
        oldUpperX: oldDocWidth,
        oldUpperY: documentHeight(oldSlots),
        viewportWidth,
        viewportHeight,
        centerX: gesture.clientX - containerRect.left,
        centerY: gesture.clientY - containerRect.top,
        applied: false,
      };
    }
    zoomTriggerRef.current = "wheel";
    zoomPointerRef.current = { x: gesture.clientX, y: gesture.clientY };
    applyZoom({ mode: "custom", level: gesture.scale });
  }, [applyZoom, clearWheelSettle, scrollContainerRef]);

  const reanchorByFraction = useCallback(
    (oldScale: number) => {
      const previousSlots = previousSlotsRef.current;
      previousSlotsRef.current = slots;
      const container = scrollContainerRef?.current ?? null;
      const documentEl = documentRef.current;
      if (!container || !documentEl || slots.length === 0) {
        activeSlotRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
        return;
      }
      const containerRect = container.getBoundingClientRect();
      const documentRect = documentEl.getBoundingClientRect();
      const scrollTop = container.scrollTop;
      const scrollLeft = container.scrollLeft;
      const documentTop = documentRect.top - containerRect.top + scrollTop;
      const documentLeft = documentRect.left - containerRect.left + scrollLeft;
      const ratio = oldScale > 0 && scale > 0 ? oldScale / scale : 1;
      const documentWidth = slots.reduce((max, slot) => Math.max(max, slot.width), 0);
      const contentHeight = documentHeight(slots);
      const previousContentWidth =
        previousSlots.length > 0
          ? previousSlots.reduce((max, slot) => Math.max(max, slot.width), 0)
          : documentWidth * ratio;
      const totalGap = PAGE_GAP_PX * Math.max(0, slots.length - 1);
      const previousContentHeight =
        previousSlots.length > 0
          ? documentHeight(previousSlots)
          : (contentHeight - totalGap) * ratio + totalGap;
      const viewportWidth = container.clientWidth;
      const viewportHeight = container.clientHeight;
      const adjustmentX: ScrollAdjustment = {
        value: scrollLeft - documentLeft,
        upper: previousContentWidth,
        pageSize: viewportWidth,
      };
      const adjustmentY: ScrollAdjustment = {
        value: scrollTop - documentTop,
        upper: previousContentHeight,
        pageSize: viewportHeight,
      };
      const centerViewport = zoomTriggerRef.current === "keyboard-step";
      const newValueX = centerViewport
        ? centerValue(adjustmentX, documentWidth, viewportWidth, viewportWidth / 2)
        : keepPositionValue(adjustmentX, documentWidth, viewportWidth);
      const newValueY = centerViewport
        ? centerValue(adjustmentY, contentHeight, viewportHeight, viewportHeight / 2)
        : keepPositionValue(adjustmentY, contentHeight, viewportHeight);
      setScrollLeft(container, documentLeft + newValueX);
      setScrollTop(container, documentTop + newValueY);
      rootRef.current?.setAttribute(
        "data-pdf-scroll-policy",
        centerViewport ? "center" : "keep-position",
      );
    },
    [scrollContainerRef, slots, scale],
  );

  const restorePageAtTop = useCallback(
    (policy: "presentation-exit" | "book-exit") => {
      const laidOut = slotsRef.current;
      const container = scrollContainerRef?.current ?? null;
      const documentEl = documentRef.current;
      const slot = laidOut[currentPage - 1] ?? null;
      previousSlotsRef.current = laidOut;
      if (!container || !documentEl || slot === null) {
        activeSlotRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
        return;
      }
      const documentTop =
        documentEl.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop;
      setScrollTop(container, documentTop + slot.top);
      anchorInfoRef.current = { page: currentPage, fraction: 0 };
      rootRef.current?.setAttribute("data-pdf-scroll-policy", policy);
    },
    [currentPage, scrollContainerRef],
  );

  const restorePresentedPage = useCallback(
    () => restorePageAtTop("presentation-exit"),
    [restorePageAtTop],
  );

  const restoreBookPage = useCallback(() => restorePageAtTop("book-exit"), [restorePageAtTop]);

  const reanchorRef = useRef<(oldScale: number) => void>(() => {});
  const restoreRef = useRef<() => void>(() => {});
  const restoreBookRef = useRef<() => void>(() => {});
  useEffect(() => {
    reanchorRef.current = reanchorByFraction;
    restoreRef.current = restorePresentedPage;
    restoreBookRef.current = restoreBookPage;
  });

  useEffect(() => {
    const pageChanged = previousPageRef.current !== currentPage;
    const scaleChanged = previousScaleRef.current !== scale;
    const previousScale = previousScaleRef.current;
    const presentationExited = previousPresentationRef.current && !presentationMode;
    const bookExited = previousBookRef.current && !bookMode;
    previousPageRef.current = currentPage;
    previousScaleRef.current = scale;
    previousPresentationRef.current = presentationMode;
    previousBookRef.current = bookMode;

    if (scaleChanged) {
      const wheelFixup = wheelScrollFixupRef.current;
      wheelScrollFixupRef.current = null;
      if (wheelFixup?.applied) return;
    }

    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (presentationMode) {
      if (pageChanged) anchorInfoRef.current = { page: currentPage, fraction: 0 };
      return;
    }
    if (presentationExited) {
      restoreRef.current();
      return;
    }
    if (bookMode) {
      if (pageChanged) anchorInfoRef.current = { page: currentPage, fraction: 0 };
      return;
    }
    if (bookExited) {
      restoreBookRef.current();
      return;
    }
    if (scaleChanged && !pageChanged) {
      reanchorRef.current(previousScale);
      return;
    }
    if (pageChanged && scrollReportedPagesRef.current.set.has(currentPage)) {
      return;
    }
    activeSlotRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
  }, [currentPage, scale, presentationMode, bookMode]);

  const pdfViewport = usePdfViewport(
    scrollContainerRef ?? { current: null },
    documentRef,
    interactive && !presentationMode,
  );
  const documentWidth = useMemo(
    () => documentSlots.reduce((max, slot) => Math.max(max, slot.width), 0),
    [documentSlots],
  );
  const pageRegions = useMemo(
    () =>
      interactive && !presentationMode && pdfViewport.width > 0 && documentSlots.length > 0
        ? visiblePageRegions(pdfViewport, documentSlots, documentWidth, REGION_OVERSCAN_PX)
        : undefined,
    [interactive, presentationMode, pdfViewport, documentSlots, documentWidth],
  );

  usePdfZoomTelemetry({
    scrollContainerRef,
    documentRef,
    scale,
    zoomMode: zoom.mode,
    zoomLevel: zoom.level,
    currentPage,
    viewport: pdfViewport,
    anchorInfoRef,
    triggerRef: zoomTriggerRef,
    pointerRef: zoomPointerRef,
  });

  const handleScrollPageChange = useCallback(
    (page: number) => {
      const memory = scrollReportedPagesRef.current;
      if (!memory.set.has(page)) {
        memory.set.add(page);
        memory.queue.push(page);
        if (memory.queue.length > SCROLL_REPORT_MEMORY) {
          memory.set.delete(memory.queue.shift()!);
        }
      }
      setPosition(pageToPosition(page, effectivePageCount));
    },
    [effectivePageCount, setPosition],
  );
  usePdfScrollTracking({
    containerRef: scrollContainerRef ?? { current: null },
    documentRef,
    slots,
    enabled: layoutReady && !presentationMode && !bookMode,
    onPageChange: handleScrollPageChange,
    anchorInfoRef,
  });

  const registerActiveSlot = useCallback((element: HTMLDivElement | null) => {
    activeSlotRef.current = element;
  }, []);

  const handlePageRendered = useCallback((pageNumber: number) => {
    setStalePages((current) => {
      if (!current.has(pageNumber)) return current;
      const next = new Set(current);
      next.delete(pageNumber);
      return next;
    });
    setRenderedPages((current) => {
      if (current.has(pageNumber)) return current;
      const next = new Set(current);
      next.add(pageNumber);
      return next;
    });
  }, []);

  const handlePageRenderedTelemetried = useCallback(
    (pageNumber: number) => {
      setFirstPainted(true);
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

  const retryPage = useCallback((pageNumber: number) => {
    setFailedPages((current) => {
      if (!current.has(pageNumber)) return current;
      const next = new Set(current);
      next.delete(pageNumber);
      return next;
    });
  }, []);

  const goToPage = (page: number) => {
    const clamped = clampPage(page, effectivePageCount);
    scrollReportedPagesRef.current.set.delete(clamped);
    setPosition(pageToPosition(clamped, effectivePageCount));
  };
  useEffect(() => {
    goToPageRef.current = goToPage;
  });

  const zoomBySteps = useCallback(
    (steps: 1 | -1) => {
      const base = wheelGestureRef.current?.scale ?? scale;
      cancelWheelGesture();
      zoomTriggerRef.current = "keyboard-step";
      zoomPointerRef.current = null;
      applyZoom({ mode: "custom", level: stepZoomLevel(base, steps) });
    },
    [applyZoom, cancelWheelGesture, scale],
  );
  const resetZoom = useCallback(() => {
    cancelWheelGesture();
    zoomTriggerRef.current = "reset";
    zoomPointerRef.current = null;
    applyZoom({ mode: "custom", level: DEFAULT_ZOOM_LEVEL });
  }, [applyZoom, cancelWheelGesture]);
  const setCustomZoom = useCallback(
    (next: number) => {
      const level = clampZoom(next);
      cancelWheelGesture();
      if (zoom.mode === "custom" && Math.abs(zoom.level - level) < 1e-9) return;
      zoomTriggerRef.current = "typed";
      zoomPointerRef.current = null;
      applyZoom({ mode: "custom", level });
    },
    [applyZoom, cancelWheelGesture, zoom.mode, zoom.level],
  );
  const setZoomMode = useCallback(
    (mode: FitZoomMode) => {
      if (zoom.mode === mode) return;
      cancelWheelGesture();
      zoomTriggerRef.current = "fit";
      zoomPointerRef.current = null;
      applyZoom({ mode, level: zoom.level });
    },
    [applyZoom, cancelWheelGesture, zoom.mode, zoom.level],
  );

  const zoomByStepsRef = useRef<(steps: 1 | -1) => void>(() => {});
  useEffect(() => {
    zoomByStepsRef.current = bookMode ? inertZoom : zoomBySteps;
  });
  const resetZoomRef = useRef<() => void>(() => {});
  useEffect(() => {
    resetZoomRef.current = bookMode ? inertZoom : resetZoom;
  });
  const setZoomModeRef = useRef<(mode: FitZoomMode) => void>(() => {});
  useEffect(() => {
    setZoomModeRef.current = bookMode ? inertZoom : setZoomMode;
  });
  const bookModeRef = useRef(bookMode);
  useEffect(() => {
    bookModeRef.current = bookMode;
  });
  useShortcut("+", () => zoomByStepsRef.current(1));
  useShortcut("=", () => zoomByStepsRef.current(1));
  useShortcut("-", () => zoomByStepsRef.current(-1));
  useShortcut("mod++", () => zoomByStepsRef.current(1));
  useShortcut("mod+=", () => zoomByStepsRef.current(1));
  useShortcut("mod+-", () => zoomByStepsRef.current(-1));
  useShortcut("mod+0", () => resetZoomRef.current());
  useShortcut("mod+1", () => setZoomModeRef.current("fit-page"));
  useShortcut("mod+2", () => setZoomModeRef.current("fit-width"));
  useShortcut("mod+3", () => setZoomModeRef.current("fit-auto"));

  useEffect(() => {
    const container = scrollContainerRef?.current ?? null;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      if (bookModeRef.current) {
        event.preventDefault();
        return;
      }
      const documentEl = documentRef.current;
      if (!documentEl) return;
      event.preventDefault();

      let gesture = wheelGestureRef.current;
      if (gesture && gesture.epoch !== zoomEpochRef.current) gesture = null;
      if (!gesture) {
        const docRect = documentEl.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const committedSlots = slotsRef.current;
        gesture = {
          scale: committedScaleRef.current,
          epoch: zoomEpochRef.current,
          originX: 0,
          originY: 0,
          clientX: event.clientX,
          clientY: event.clientY,
          docLeft: docRect.left - containerRect.left + container.scrollLeft,
          docTop: docRect.top - containerRect.top + container.scrollTop,
          docWidth: committedSlots.reduce((max, slot) => Math.max(max, slot.width), 0),
          docHeight: documentHeight(committedSlots),
        };
      }

      const scale = wheelZoomScale(
        gesture.scale,
        event.deltaY,
        event.deltaMode,
        container.clientHeight || 1,
      );
      // The preview scales about the cursor only on an axis that can scroll at the target scale.
      const containerRect = container.getBoundingClientRect();
      const ratio = committedScaleRef.current > 0 ? scale / committedScaleRef.current : 1;
      const cursorX = event.clientX - containerRect.left + container.scrollLeft - gesture.docLeft;
      const cursorY = event.clientY - containerRect.top + container.scrollTop - gesture.docTop;
      const originX =
        gesture.docWidth * ratio > container.clientWidth ? cursorX : gesture.docWidth / 2;
      const originY = gesture.docHeight * ratio > container.clientHeight ? cursorY : 0;
      gesture = {
        ...gesture,
        scale,
        originX,
        originY,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      wheelGestureRef.current = gesture;
      setWheelPreview({ scale, originX, originY });

      if (wheelSettleRef.current !== null) window.clearTimeout(wheelSettleRef.current);
      wheelSettleRef.current = window.setTimeout(commitWheelGesture, WHEEL_SETTLE_MS);
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
      commitWheelGesture();
      clearWheelSettle();
    };
  }, [scrollContainerRef, commitWheelGesture, clearWheelSettle]);

  useLayoutEffect(() => {
    const fixup = wheelScrollFixupRef.current;
    const container = scrollContainerRef?.current ?? null;
    const documentEl = documentRef.current;
    if (!fixup || fixup.applied || !container || !documentEl) return;
    if (scale !== fixup.targetScale) return;
    const containerRect = container.getBoundingClientRect();
    const documentRect = documentEl.getBoundingClientRect();
    const docLeft = documentRect.left - containerRect.left + container.scrollLeft;
    const docTop = documentRect.top - containerRect.top + container.scrollTop;
    const newDocWidth = slots.reduce((max, slot) => Math.max(max, slot.width), 0);
    const newValueY = adjustmentValueForPolicy(
      "center",
      { value: fixup.oldValueY, upper: fixup.oldUpperY, pageSize: fixup.viewportHeight },
      documentHeight(slots),
      fixup.viewportHeight,
      fixup.centerY,
    );
    const newValueX = adjustmentValueForPolicy(
      "center",
      { value: fixup.oldValueX, upper: fixup.oldUpperX, pageSize: fixup.viewportWidth },
      newDocWidth,
      fixup.viewportWidth,
      fixup.centerX,
    );
    setScrollTop(container, docTop + newValueY);
    setScrollLeft(container, docLeft + newValueX);
    rootRef.current?.setAttribute("data-pdf-scroll-policy", "center");
    wheelScrollFixupRef.current = { ...fixup, applied: true };
  });

  const [presentationSync, setPresentationSync] = useState<{
    active: boolean;
    saved: ZoomState | null;
  }>(() => ({ active: presentationMode, saved: null }));
  if (presentationSync.active !== presentationMode) {
    const saved = presentationMode ? zoom : presentationSync.saved;
    setWheelPreview(null);
    setZoomEpoch((epoch) => epoch + 1);
    setPresentationSync({ active: presentationMode, saved: presentationMode ? zoom : null });
    setZoom(
      presentationMode ? { mode: "fit-page", level: DEFAULT_ZOOM_LEVEL } : (saved as ZoomState),
    );
    setRenderedPages(new Set());
    setFailedPages(new Set());
    setStalePages(new Set());
    setCacheState({ document: pdfDocument, cache: new PdfBitmapCache() });
  }

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
        data-pdf-engine-state={
          layoutReady ? "layout-ready" : status === "ready" ? "document-parsed" : "document-loading"
        }
        {...openTelemetry}
        className="mx-auto max-w-3xl px-6 py-8"
      >
        <p
          data-testid="pdf-loading"
          className="text-center text-sm text-[var(--reader-chrome-muted,var(--muted-foreground))]"
        >
          Loading {book.title}…
        </p>
      </div>
    );
  }

  const stepPageOrSpread = (delta: 1 | -1) => {
    const turn = bookMode ? (bookTurnRef?.current ?? null) : null;
    if (turn) {
      if (delta === 1) turn.advance();
      else turn.retreat();
      return;
    }
    goToPage(currentPage + delta);
  };
  const displayScale = wheelPreview?.scale ?? scale;
  const controls = (
    <PdfToolbar
      pageNumber={currentPage}
      pageCount={effectivePageCount}
      zoomMode={zoom.mode}
      zoomScale={displayScale}
      canZoomIn={displayScale < MAX_ZOOM - 1e-9}
      canZoomOut={displayScale > MIN_ZOOM + 1e-9}
      onPrev={() => stepPageOrSpread(-1)}
      onNext={() => stepPageOrSpread(1)}
      onSetPage={goToPage}
      pageEntryDisabled={!layoutReady}
      onZoomIn={() => zoomByStepsRef.current(1)}
      onZoomOut={() => zoomByStepsRef.current(-1)}
      onSelectFit={setZoomMode}
      onSetZoom={setCustomZoom}
      onTogglePresentation={onTogglePresentation}
      presentationActive={presentationMode}
      zoomHidden={bookMode}
    />
  );

  return (
    <div
      ref={rootRef}
      data-testid="pdf-reader"
      data-pdf-engine-state="interactive"
      data-pdf-presentation={presentationMode}
      data-pdf-book-mode={bookMode}
      data-pdf-worker-src={pdfWorkerSrc()}
      data-pdf-bitmap-cache={`${bitmapCache.size}:${bitmapCache.byteSize}`}
      data-pdf-preload-count={preloadCount}
      data-pdf-current-page={currentPage}
      data-pdf-visible-pages={[...visiblePages].sort((a, b) => a - b).join(",")}
      data-pdf-preload-pages={[...preloadPages].sort((a, b) => a - b).join(",")}
      data-pdf-render-order={renderOrder.join(",")}
      data-pdf-render-permitted={[...renderPermittedPages].sort((a, b) => a - b).join(",")}
      {...openTelemetry}
      className={
        presentationMode
          ? "flex h-full flex-col items-stretch p-0"
          : "flex flex-col items-stretch px-6 py-4"
      }
    >
      {presentationMode ? (
        <PdfPresentationBar
          pageNumber={currentPage}
          pageCount={effectivePageCount}
          onPrev={() => goToPage(currentPage - 1)}
          onNext={() => goToPage(currentPage + 1)}
          onSetPage={goToPage}
          pageEntryDisabled={!layoutReady}
          onExit={onExitPresentation}
        />
      ) : (
        controlsHost && createPortal(controls, controlsHost)
      )}
      {!presentationMode && !controlsHost && controls}
      {bookMode && sizes ? (
        <PdfBookView
          document={pdfDocument}
          sizes={sizes}
          currentPage={currentPage}
          bitmapCache={bitmapCache}
          areaWidth={areaWidth}
          viewportHeight={viewportHeight}
          contentAreaRef={contentAreaRef}
          smartColors={treatment.smart}
          renderVariant={renderVariant}
          pageBackground={treatment.pageBackground}
          highlights={{
            byPage: highlightsByPage,
            family: readerThemeFamily(effectiveTheme),
            overrides: preferences.highlightOverrides,
          }}
          themePaint={{ filter: treatment.filter, tint: treatment.tint }}
          bookTurnRef={bookTurnRef}
        />
      ) : (
        <PdfDocumentView
          document={pdfDocument}
          slots={documentSlots}
          renderPages={canvasPages}
          renderPermittedPages={renderPermittedPages}
          anchorPage={currentPage}
          scale={scale}
          previewTransform={
            wheelPreview
              ? {
                  ratio: wheelPreview.scale / scale,
                  originX: wheelPreview.originX,
                  originY: wheelPreview.originY,
                }
              : undefined
          }
          pageRegions={pageRegions}
          renderedPages={renderedPages}
          failedPages={failedPages}
          bitmapCache={bitmapCache}
          previewAnchorRender={renderedPages.size === 0 && stalePages.size === 0}
          onPageRendered={handlePageRenderedTelemetried}
          onPageError={handlePageError}
          registerSlot={registerSlot}
          registerAnchorSlot={registerActiveSlot}
          documentRef={documentRef}
          contentAreaRef={contentAreaRef}
          onRetryPage={retryPage}
          highlightsByPage={highlightsByPage}
          highlightFamily={readerThemeFamily(effectiveTheme)}
          highlightOverrides={preferences.highlightOverrides}
          themeFilter={treatment.filter}
          themeTint={treatment.tint}
          smartColors={treatment.smart}
          renderVariant={renderVariant}
          presentation={presentationMode}
          pageBackground={treatment.pageBackground}
        />
      )}
      {sidebarHost &&
        !presentationMode &&
        createPortal(
          <PdfSidebar
            document={pdfDocument}
            sizes={sizes}
            currentPage={currentPage}
            measurePages={measurePages}
            onNavigate={goToPage}
            smartColors={treatment.smart}
            renderVariant={renderVariant}
            pageBackground={treatment.pageBackground}
          />,
          sidebarHost,
        )}
    </div>
  );
}
