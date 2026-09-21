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
import { usePdfDocument } from "./hooks/usePdfDocument";
import { usePdfGeometry } from "./hooks/usePdfGeometry";
import { usePdfScale } from "./hooks/usePdfScale";
import { usePdfSearch } from "./hooks/usePdfSearch";
import {
  READING_ANCHOR_RATIO,
  setScrollLeft,
  setScrollTop,
  usePdfScrollTracking,
  type PdfAnchorInfo,
} from "./hooks/usePdfScrollTracking";
import { usePdfViewport, type PdfViewport } from "./hooks/usePdfViewport";
import { usePdfVirtualization } from "./hooks/usePdfVirtualization";
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
} from "./pdfRenderPolicy";
import {
  adjustmentUpper,
  adjustmentValueForPolicy,
  clampZoom,
  DEFAULT_ZOOM_LEVEL,
  MAX_ZOOM,
  MIN_ZOOM,
  displayedSizes,
  documentHeight,
  documentMaxPageSize,
  keepPositionValue,
  layoutSlots,
  stepZoomLevel,
  visiblePageRegion,
  wheelZoomScale,
  type FitZoomMode,
  type LayoutSlot,
  type Rect,
  type ScrollAdjustment,
  type ZoomMode,
} from "./pdfLayout";
import { pageToPosition, positionToPage } from "./pdfPages";
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
 * are frozen for the whole gesture — every Ctrl+wheel event is prevented —
 * so the captured geometry stays valid until settle.
 */
interface WheelGesture extends WheelPreview {
  epoch: number;
  clientX: number;
  clientY: number;
  docLeft: number;
  docTop: number;
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
  // Re-selecting highlighted text addresses that highlight (largest
  // overlap) instead of stacking a new one on top.
  const targeted = highlightForSelection(
    input.highlightsByPage.get(found.page) ?? [],
    found.page,
    rects,
  );
  return { kind: "select", page: found.page, text, rects, highlightId: targeted?.id ?? null };
}

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

  // Theme treatment (issue #67): the dark preset is Smart Dark — pages
  // rasterize with worker-side object-aware recoloring (no CSS filter);
  // Invert keeps the full-page negative as a filter; Paper tints; the rest
  // render as-is. The smart palette rides the render requests, and the
  // color-mode variant keys the bitmap cache: switching modes must
  // invalidate rendered canvases and cached bitmaps (a mode change is a
  // pixel change, not a zoom change). The invalidation itself runs after
  // the render-bookkeeping state is declared, in the established
  // render-phase reset pattern.
  const treatment = pdfThemeTreatment(preferences.theme);
  const renderVariant = treatment.smart ? "smart" : "original";

  const [zoom, setZoom] = useState<ZoomState>(DEFAULT_ZOOM_STATE);
  const [renderedPages, setRenderedPages] = useState<ReadonlySet<number>>(() => new Set());
  const [failedPages, setFailedPages] = useState<ReadonlySet<number>>(() => new Set());
  // Pages holding a previous-scale bitmap kept on screen through a zoom
  // commit. Scale-and-swap (PdfPageCanvas) paints them transformed while the
  // pages admitted to the render budget rasterize; a completed render clears
  // its page from this set. Reset with the document, the color variant, and
  // a presentation flip, never on an ordinary zoom.
  const [stalePages, setStalePages] = useState<ReadonlySet<number>>(() => new Set());
  const renderedPagesRef = useRef(renderedPages);
  useEffect(() => {
    renderedPagesRef.current = renderedPages;
  });

  const effectivePageCount = pageCount > 0 ? pageCount : PDF_PLACEHOLDER_PAGE_COUNT;
  const currentPage = positionToPage(position, effectivePageCount);
  const layoutReady = status === "ready" && sizes !== null;

  // Layout scale from the zoom state (§ issue #65): fit modes recompute
  // from the measured content area and viewport; presentation mode fits the
  // whole page being read inside the area (both axes) so mixed-size
  // documents rescale per page and any page shape stays fully visible.
  // Document-wide fit uses the largest page, not page 1, matching Papers'
  // pps_document_get_max_page_size, so a mixed document's widest or tallest
  // page sets the scale. The request object is memoized — it is the scale
  // hook's effect dependency.
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
  const { scale, contentAreaRef: registerContentArea } = usePdfScale(
    scaleRequest,
    scrollContainerRef,
  );

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
  // after the first page has rendered, so it can never occupy the PDFium
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
  // Latest layout for the imperative wheel-commit scroll math, which runs in
  // a layout effect and must not re-create the wheel listener every zoom.
  const slotsRef = useRef(slots);
  useEffect(() => {
    slotsRef.current = slots;
  });

  // Presentation mode is a single-page surface: only the current page's slot
  // is laid out, so no neighbour can peek in from the scroll container. The
  // document view centres that one page in the viewport. Outside
  // presentation the full continuous document is used.
  const documentSlots = useMemo(
    () => (presentationMode ? slots.filter((slot) => slot.pageNumber === currentPage) : slots),
    [presentationMode, slots, currentPage],
  );

  // Rendering policy, modeled on the classic viewer render queues,
  // adjusted for what the PDFium worker actually parallelizes — see
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
    const slotsByPage = new Map(documentSlots.map((slot) => [slot.pageNumber, slot]));
    const dpr = window.devicePixelRatio || 1;
    const bufferBytes = (page: number): number => {
      const slot = slotsByPage.get(page);
      if (!slot) return 0;
      const ratio = effectiveRenderRatio(slot.width / scale, slot.height / scale, scale, dpr);
      return renderBufferBytes(slot.width, slot.height, ratio);
    };
    return capByBytes(active, bufferBytes, MAX_ACTIVE_CANVAS_BYTES).slice(0, MAX_ACTIVE_CANVASES);
  }, [currentPage, visiblePages, preloadPages, documentSlots, scale]);

  // The render set, derived purely from the priority order and the
  // completion/failure state: the first MAX_CONCURRENT_RENDERS unrendered
  // pages of `renderOrder` own the render budget (bounded concurrency in
  // flight), and completed canvases stay mounted while their page remains
  // in-window. A zoom does not unmount the pages that held pixels: they are
  // kept as display-only scale-and-swap (stalePages) until either the render
  // budget admits them or they leave the window, so the visible surface is
  // never blank through the commit. `renderPermittedPages` is exactly the
  // budget, and PdfPageCanvas refuses to raster outside it.
  const { canvasPages, renderPermittedPages } = useMemo(() => {
    const window = new Set(renderOrder);
    const rendering: number[] = [];
    for (const page of renderOrder) {
      if (rendering.length >= MAX_CONCURRENT_RENDERS) break;
      if (renderedPages.has(page) || failedPages.has(page)) continue;
      rendering.push(page);
    }
    const mounted = new Set<number>();
    for (const page of renderedPages) if (window.has(page)) mounted.add(page);
    for (const page of stalePages) if (window.has(page)) mounted.add(page);
    for (const page of rendering) mounted.add(page);
    return { canvasPages: [...mounted], renderPermittedPages: new Set(rendering) };
  }, [renderOrder, renderedPages, failedPages, stalePages]);

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
    setStalePages(new Set());
  }

  // Color-mode invalidation (issue #67): a theme switch between modes with
  // different rendered pixels (as-is ↔ Smart Dark) is a pixel change —
  // rendered canvases, failure marks, and the bitmap cache reset with the
  // variant, exactly like a document switch. Filter/tint-only switches
  // (Invert, Paper) keep variant "original": the CSS treatment applies to
  // the same pixels live.
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

  // Measure pages as they approach visibility so slot estimates become real
  // dimensions before their canvases render (lazy geometry correction).
  useEffect(() => {
    if (!layoutReady || (visiblePages.size === 0 && preloadPages.size === 0)) return;
    measurePages([...visiblePages, ...preloadPages]);
  }, [layoutReady, measurePages, visiblePages, preloadPages]);

  // Re-anchor after layout-scale changes (zoom, fit recalculation,
  // window resize, presentation rescale): the anchor's page + in-page
  // fraction — kept current by the scroll tracker — is mapped onto the
  // rescaled layout, so
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
  const previousSlotsRef = useRef(slots);
  const mountedRef = useRef(false);

  // A zoom or fit-mode change invalidates rendered canvases; the new scale
  // re-renders the visible pages while evicted slots simply resize their
  // reservations. Cached bitmaps are keyed by scale, so they are dropped
  // too. The pages that held pixels before the zoom move to `stalePages`
  // instead of vanishing: PdfPageCanvas keeps painting their previous bitmap
  // under a transform until the new-scale raster swaps in (scale-and-swap).
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

  // § Ctrl+wheel gesture (smooth zoom): wheel events only move a transient
  // preview — a CSS transform on the document element about the cursor —
  // while the committed layout scale stays put. WHEEL_SETTLE_MS after the
  // last event the preview commits: the zoom state takes the previewed
  // scale, the cursor point is scrolled back under the cursor, and the
  // canvases rasterize once, sharp.
  const [wheelPreview, setWheelPreview] = useState<WheelPreview | null>(null);
  // Bumped whenever a zoom change happens outside the gesture (currently
  // the presentation flip): a gesture started before it is stale and its
  // settle commit must be discarded, not applied over the new state.
  const [zoomEpoch, setZoomEpoch] = useState(0);
  const wheelGestureRef = useRef<WheelGesture | null>(null);
  const wheelSettleRef = useRef<number | null>(null);
  // Set at commit, applied by the layout effect below once React has
  // re-laid out at the new scale (the scroll math needs the new geometry),
  // then consumed by the re-anchor effect so the commit's own scale change
  // skips the reading-spot re-anchor — the cursor point supersedes it. The
  // offsets are document-local (scroll minus the document element's position
  // in scroll content) and the policy is Papers' SCROLL_TO_CENTER: the
  // pointer holds the same document fraction across the scale change.
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

  // A non-wheel zoom action owns the next move: drop the preview (the same
  // render applies the action's scale, so the page never snaps back).
  const cancelWheelGesture = useCallback(() => {
    clearWheelSettle();
    wheelGestureRef.current = null;
    setWheelPreview(null);
  }, [clearWheelSettle]);

  // Commit the previewed scale. Non-wheel actions running first have
  // already cancelled the gesture; a gesture overtaken by a zoom-epoch bump
  // (presentation flip) is discarded instead of committing over it.
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
    // No scroll container (standalone render): there is no scroll position to
    // hold, so commit the scale without a focal-anchor fixup.
    if (container) {
      const containerRect = container.getBoundingClientRect();
      const oldSlots = slotsRef.current;
      const oldDocWidth = oldSlots.reduce((max, slot) => Math.max(max, slot.width), 0);
      const viewportWidth = container.clientWidth;
      const viewportHeight = container.clientHeight;
      // Capture the old adjustment in document-local coordinates; the layout
      // effect re-derives the new upper once React has laid out the new scale.
      wheelScrollFixupRef.current = {
        targetScale: gesture.scale,
        oldValueX: container.scrollLeft - gesture.docLeft,
        oldValueY: container.scrollTop - gesture.docTop,
        oldUpperX: adjustmentUpper(viewportWidth, oldDocWidth),
        oldUpperY: adjustmentUpper(viewportHeight, documentHeight(oldSlots)),
        viewportWidth,
        viewportHeight,
        centerX: gesture.clientX - containerRect.left,
        centerY: gesture.clientY - containerRect.top,
        applied: false,
      };
    }
    applyZoom({ mode: "custom", level: gesture.scale });
  }, [applyZoom, clearWheelSettle, scrollContainerRef]);

  const reanchorByFraction = useCallback(() => {
    // The layout in effect before this scale change; it is the "old" content
    // for the keep-position fallback below. Updated here (not in the effect
    // that calls this) so the effect never depends on `slots` and so a
    // measurement-only slots change never re-anchors the viewport.
    const previousSlots = previousSlotsRef.current;
    previousSlotsRef.current = slots;
    const container = scrollContainerRef?.current ?? null;
    const documentEl = documentRef.current;
    if (!container || !documentEl || slots.length === 0) {
      activeSlotRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
      return;
    }
    const documentTop =
      documentEl.getBoundingClientRect().top -
      container.getBoundingClientRect().top +
      container.scrollTop;
    const info = anchorInfoRef.current;
    if (!info) {
      // No page anchor yet (scroll tracking has not sampled): fall back to
      // Papers' SCROLL_TO_KEEP_POSITION, the old document-local offset
      // reapplied to the new content by its relative position.
      const viewportHeight = container.clientHeight;
      const adjustment: ScrollAdjustment = {
        value: container.scrollTop - documentTop,
        upper: adjustmentUpper(viewportHeight, documentHeight(previousSlots)),
        pageSize: viewportHeight,
      };
      setScrollTop(
        container,
        documentTop +
          keepPositionValue(
            adjustment,
            adjustmentUpper(viewportHeight, documentHeight(slots)),
            viewportHeight,
          ),
      );
      rootRef.current?.setAttribute("data-pdf-scroll-policy", "keep-position");
      return;
    }
    const slot = slots.find((candidate) => candidate.pageNumber === info.page) ?? slots[0];
    if (!slot) return;
    const targetAnchor = slot.top + info.fraction * slot.height;
    setScrollTop(
      container,
      targetAnchor + documentTop - container.clientHeight * READING_ANCHOR_RATIO,
    );
    rootRef.current?.setAttribute("data-pdf-scroll-policy", "keep-position");
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
  // scroll and re-anchoring is skipped. A scale change alone (zoom, fit
  // recalculation) re-anchors by fraction; a page change from navigation
  // (toolbar, restore) lands on the new page's top edge. Presentation mode
  // lays out one centred page, so there is nothing to scroll: the effect
  // only keeps its page/scale bookkeeping current.
  useEffect(() => {
    const pageChanged = previousPageRef.current !== currentPage;
    const scaleChanged = previousScaleRef.current !== scale;
    previousPageRef.current = currentPage;
    previousScaleRef.current = scale;

    // A wheel-gesture commit pins the cursor point through its own scroll
    // fixup, which supersedes the reading-spot anchor for exactly the
    // render where the committed scale lands (the tracker refreshes the
    // anchor from the adjusted scroll position right after).
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
      // Scroll tracking is off here, so keep the re-anchor anchor on the
      // flipped-to page; exiting the mode then restores that page.
      if (pageChanged) anchorInfoRef.current = { page: currentPage, fraction: 0 };
      return;
    }
    if (scaleChanged && !pageChanged) {
      reanchorRef.current();
      return;
    }
    if (pageChanged && scrollReportedPageRef.current === currentPage) {
      return;
    }
    activeSlotRef.current?.scrollIntoView({ block: "start", inline: "nearest" });
  }, [currentPage, scale, presentationMode]);

  // Viewport clipping (high zoom): sample the scroll frame and derive each
  // laid-out page's visible region. Only canvases whose whole-page ratio
  // would fall below device resolution consume it (PdfPageCanvas decides),
  // so at fit width this is inert.
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
    // Presentation lays out a single centred page, so scroll position does
    // not name the current page there; flips come from navigation only.
    enabled: layoutReady && !presentationMode,
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

  // Manual zoom (preset stepping): the effective scale snaps onto the
  // nearest preset first, so zooming out of a fit mode continues from where
  // the page actually is (issue #65). A live wheel gesture flushes into the
  // base scale — the previewed zoom, not the stale committed one.
  const zoomBySteps = useCallback(
    (steps: 1 | -1) => {
      const base = wheelGestureRef.current?.scale ?? scale;
      cancelWheelGesture();
      applyZoom({ mode: "custom", level: stepZoomLevel(base, steps) });
    },
    [applyZoom, cancelWheelGesture, scale],
  );
  const resetZoom = useCallback(() => {
    cancelWheelGesture();
    applyZoom({ mode: "custom", level: DEFAULT_ZOOM_LEVEL });
  }, [applyZoom, cancelWheelGesture]);
  // Typed/preset zoom: clamp onto the supported range and skip a no-op apply
  // so re-selecting the current level never clears the render set.
  const setCustomZoom = useCallback(
    (next: number) => {
      const level = clampZoom(next);
      cancelWheelGesture();
      if (zoom.mode === "custom" && Math.abs(zoom.level - level) < 1e-9) return;
      applyZoom({ mode: "custom", level });
    },
    [applyZoom, cancelWheelGesture, zoom.mode, zoom.level],
  );
  const setZoomMode = useCallback(
    (mode: FitZoomMode) => {
      if (zoom.mode === mode) return;
      cancelWheelGesture();
      applyZoom({ mode, level: zoom.level });
    },
    [applyZoom, cancelWheelGesture, zoom.mode, zoom.level],
  );

  // Latest handlers for the keyboard/wheel registrations below (the
  // registrations are stable; the closures track the live scale).
  const zoomByStepsRef = useRef<(steps: 1 | -1) => void>(() => {});
  useEffect(() => {
    zoomByStepsRef.current = zoomBySteps;
  });
  const resetZoomRef = useRef<() => void>(() => {});
  useEffect(() => {
    resetZoomRef.current = resetZoom;
  });
  const setZoomModeRef = useRef<(mode: FitZoomMode) => void>(() => {});
  useEffect(() => {
    setZoomModeRef.current = setZoomMode;
  });
  // Keyboard zoom (§ reader keyboard, issue #65): Ctrl + +/-/0 and the fit
  // modes on Ctrl+1/2/3, plus the historical bare +/=/- steps. The shell
  // does not bind these, so there is no conflict with global reader
  // shortcuts. Both +/=/- spellings are registered: the shifted `+` and
  // the unshifted `=` share a key on most layouts.
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

  // Ctrl + mouse wheel zooms (and trackpad pinch, which Chromium reports as
  // a ctrl-modified wheel): the scroller never zooms the page natively, so
  // the default must be suppressed. Each event multiplies the previewed
  // scale continuously (wheelZoomScale); the page re-renders only once the
  // gesture settles.
  useEffect(() => {
    const container = scrollContainerRef?.current ?? null;
    if (!container) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      const documentEl = documentRef.current;
      if (!documentEl) return;
      event.preventDefault();

      let gesture = wheelGestureRef.current;
      if (gesture && gesture.epoch !== zoomEpochRef.current) gesture = null;
      if (!gesture) {
        // First tick of the gesture (or a stale one after a zoom-epoch
        // bump): capture where the document element sits in scroll content,
        // untransformed. Both layout and scroll stay put for the whole
        // gesture, so this geometry stays valid until commit.
        const docRect = documentEl.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        gesture = {
          scale: committedScaleRef.current,
          epoch: zoomEpochRef.current,
          originX: 0,
          originY: 0,
          clientX: event.clientX,
          clientY: event.clientY,
          docLeft: docRect.left - containerRect.left + container.scrollLeft,
          docTop: docRect.top - containerRect.top + container.scrollTop,
        };
      }

      // The origin follows the cursor: the document point under the pointer
      // is what the zoom keeps fixed (transform-origin on the document).
      const containerRect = container.getBoundingClientRect();
      const originX = event.clientX - containerRect.left + container.scrollLeft - gesture.docLeft;
      const originY = event.clientY - containerRect.top + container.scrollTop - gesture.docTop;
      const scale = wheelZoomScale(
        gesture.scale,
        event.deltaY,
        event.deltaMode,
        container.clientHeight || 1,
      );
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
      // Flush rather than discard: a reader torn down (or its scroll
      // container swapped) mid-gesture still lands the previewed zoom.
      commitWheelGesture();
      clearWheelSettle();
    };
  }, [scrollContainerRef, commitWheelGesture, clearWheelSettle]);

  // Wheel-gesture commit fixup: runs right after React re-lays out at the
  // committed scale (before the browser paints), scrolling so the document
  // point that sat under the cursor still sits there. The policy is Papers'
  // SCROLL_TO_CENTER (`pdfLayout.centerValue`): the document-local offset
  // under the cursor keeps the same fraction of the new `MAX(viewport,
  // content)`, which holds the cursor point through the scale change. This
  // replaces the previous DOM-ratio fixup, so the reader and the geometry
  // oracle share one implementation. The document element is read at its new,
  // untransformed layout here.
  useLayoutEffect(() => {
    const fixup = wheelScrollFixupRef.current;
    const container = scrollContainerRef?.current ?? null;
    const documentEl = documentRef.current;
    // One application: the fixup is consumed only at the render where the
    // layout scale lands, which usePdfScale now derives in the same commit as
    // the zoom state. Applying before then would read the old content extents
    // and compute a no-op.
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
      adjustmentUpper(fixup.viewportHeight, documentHeight(slots)),
      fixup.viewportHeight,
      fixup.centerY,
    );
    const newValueX = adjustmentValueForPolicy(
      "center",
      { value: fixup.oldValueX, upper: fixup.oldUpperX, pageSize: fixup.viewportWidth },
      adjustmentUpper(fixup.viewportWidth, newDocWidth),
      fixup.viewportWidth,
      fixup.centerX,
    );
    setScrollTop(container, docTop + newValueY);
    setScrollLeft(container, docLeft + newValueX);
    rootRef.current?.setAttribute("data-pdf-scroll-policy", "center");
    wheelScrollFixupRef.current = { ...fixup, applied: true };
  });

  // Presentation mode is a dynamic page-fit mode (§ issue #65): entering
  // saves the previous zoom state and switches to fit-page (the current
  // page and its position are untouched — the scale hook derives the scale
  // per page); leaving restores exactly what was saved. Render-phase
  // adjustment: the prop flip is the trigger, so the zoom state adjusts in
  // the same render pass (the React-recommended alternative to a
  // setState-in-effect cascade). The invalidation mirrors applyZoom, but
  // the bitmap cache is replaced wholesale (the established render-phase
  // pattern) instead of mutated mid-render.
  const [presentationSync, setPresentationSync] = useState<{
    active: boolean;
    saved: ZoomState | null;
  }>(() => ({ active: presentationMode, saved: null }));
  if (presentationSync.active !== presentationMode) {
    const saved = presentationMode ? zoom : presentationSync.saved;
    // A pending wheel gesture belongs to whichever mode was on screen: drop
    // its preview and bump the epoch so the settle commit discards it
    // instead of applying over the restored fit state.
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
        <p
          data-testid="pdf-loading"
          className="text-center text-sm text-[var(--reader-chrome-muted,var(--muted-foreground))]"
        >
          Loading {book.title}…
        </p>
      </div>
    );
  }

  // Document controls (page navigation + zoom): docked into the shell's
  // header host when one is provided, inline above the document otherwise
  // (standalone renders). In presentation mode the header chrome is hidden
  // by the shell; the document instead carries the minimal floating bar
  // (prev/next, the page indicator, exit) so the workflow stays
  // pointer-accessible without leaving the mode (§ issue #65).
  // The toolbar reports the effective scale live: during a wheel gesture
  // that is the previewed zoom, before any canvas has re-rendered.
  const displayScale = wheelPreview?.scale ?? scale;
  const controls = (
    <PdfToolbar
      pageNumber={currentPage}
      pageCount={effectivePageCount}
      zoomMode={zoom.mode}
      zoomScale={displayScale}
      canZoomIn={displayScale < MAX_ZOOM - 1e-9}
      canZoomOut={displayScale > MIN_ZOOM + 1e-9}
      onPrev={() => goToPage(currentPage - 1)}
      onNext={() => goToPage(currentPage + 1)}
      onZoomIn={() => zoomByStepsRef.current(1)}
      onZoomOut={() => zoomByStepsRef.current(-1)}
      onSelectFit={setZoomMode}
      onSetZoom={setCustomZoom}
      onTogglePresentation={onTogglePresentation}
      presentationActive={presentationMode}
    />
  );

  return (
    <div
      ref={rootRef}
      data-testid="pdf-reader"
      data-pdf-engine-state="interactive"
      data-pdf-presentation={presentationMode}
      data-pdf-worker-src={pdfWorkerSrc()}
      data-pdf-bitmap-cache={`${bitmapCache.size}:${bitmapCache.byteSize}`}
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
          onExit={onExitPresentation}
        />
      ) : (
        controlsHost && createPortal(controls, controlsHost)
      )}
      {!presentationMode && !controlsHost && controls}
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
        themeFilter={treatment.filter}
        themeTint={treatment.tint}
        smartColors={treatment.smart}
        renderVariant={renderVariant}
        presentation={presentationMode}
        pageBackground={treatment.pageBackground}
      />
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
