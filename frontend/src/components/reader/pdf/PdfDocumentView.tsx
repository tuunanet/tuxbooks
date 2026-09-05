import { useMemo, type CSSProperties, type Ref } from "react";
import type { Annotation } from "@/types/domain";
import type { PdfDocument } from "@/lib/pdf/pdfEngine";
import { PdfHighlightOverlay } from "./PdfHighlightOverlay";
import { PdfPageCanvas } from "./PdfPageCanvas";
import { PdfPageSlot, type PdfPageLifecycle } from "./PdfPageSlot";
import { PdfPageTextLayer } from "./PdfPageTextLayer";
import type { PdfBitmapCache } from "./pdfBitmapCache";
import type { LayoutSlot } from "./pdfLayout";

interface PdfDocumentViewProps {
  document: PdfDocument;
  slots: LayoutSlot[];
  /**
   * Pages that should own a canvas right now, ordered by render priority
   * (bounded by the reader's render budget). Every other page stays a
   * geometry-only slot.
   */
  renderPages: number[];
  /** The page the reading position names; its slot is the scroll target. */
  anchorPage: number;
  /** PDF.js render scale for the canvases. */
  scale: number;
  renderedPages: ReadonlySet<number>;
  failedPages: ReadonlySet<number>;
  /** Shared per-document cache of finished page bitmaps. */
  bitmapCache?: PdfBitmapCache | null;
  onPageRendered: (pageNumber: number) => void;
  onPageError: (pageNumber: number, error: unknown) => void;
  registerSlot: (pageNumber: number, element: HTMLDivElement | null) => void;
  /** Registers the anchor page's slot element for scroll targeting. */
  registerAnchorSlot: (element: HTMLDivElement | null) => void;
  /** Receives the document element for scroll-position math. */
  documentRef?: Ref<HTMLDivElement>;
  /** Receives the content area element that defines the fit width. */
  contentAreaRef?: Ref<HTMLDivElement>;
  /** Called when the user asks a failed page to render again. */
  onRetryPage?: (pageNumber: number) => void;
  /** Persisted highlights by page number; drawn over rendered pages. */
  highlightsByPage?: Map<number, Annotation[]>;
}

/**
 * CSS custom properties the PDF.js text layer expects on its ancestor
 * (`--scale-factor` = the render scale in CSS px per page unit; see
 * pdfTextLayer.css).
 */
const scaleCssProperties = (scale: number): CSSProperties =>
  ({
    "--scale-factor": scale,
    "--user-unit": 1,
    "--total-scale-factor": "calc(var(--scale-factor) * var(--user-unit))",
    "--scale-round-x": "1px",
    "--scale-round-y": "1px",
  }) as CSSProperties;

/**
 * The virtualized continuous document surface: one lightweight slot per page
 * (the whole document reserves its space up front) with canvases only on the
 * bounded render set. Slot geometry comes from the layout layer; DOM flow
 * reproduces it exactly, so computed offsets and real offsets never disagree.
 */
export function PdfDocumentView({
  document,
  slots,
  renderPages,
  anchorPage,
  scale,
  renderedPages,
  failedPages,
  bitmapCache = null,
  onPageRendered,
  onPageError,
  registerSlot,
  registerAnchorSlot,
  documentRef,
  contentAreaRef,
  onRetryPage,
  highlightsByPage,
}: PdfDocumentViewProps) {
  const canvasPages = useMemo(() => new Set(renderPages), [renderPages]);
  const documentWidth = slots.reduce((max, slot) => Math.max(max, slot.width), 0);

  return (
    <div
      ref={contentAreaRef}
      data-testid="pdf-content-area"
      className="flex min-h-0 w-full justify-center overflow-x-auto"
    >
      <div
        ref={documentRef}
        data-testid="pdf-document"
        style={{ width: `${documentWidth}px` }}
        className="flex flex-col items-center"
      >
        {slots.map((slot, index) => {
          // Canvases live only on the render set, so lifecycle states stay
          // honest: a page outside the set is unloaded unless it failed —
          // failures keep their slot flagged (with retry) until retried.
          let state: PdfPageLifecycle = "unloaded";
          if (failedPages.has(slot.pageNumber)) {
            state = "error";
          } else if (canvasPages.has(slot.pageNumber)) {
            state = renderedPages.has(slot.pageNumber) ? "rendered" : "rendering";
          }

          return (
            <PdfPageSlot
              key={slot.pageNumber}
              slot={slot}
              gapAbove={index > 0}
              state={state}
              registerRef={
                slot.pageNumber === anchorPage
                  ? (element) => {
                      registerSlot(slot.pageNumber, element);
                      registerAnchorSlot(element);
                    }
                  : (element) => registerSlot(slot.pageNumber, element)
              }
              onRetry={onRetryPage ? () => onRetryPage(slot.pageNumber) : undefined}
            >
              {canvasPages.has(slot.pageNumber) ? (
                <div className="relative" style={scaleCssProperties(scale)}>
                  <PdfPageCanvas
                    document={document}
                    pageNumber={slot.pageNumber}
                    width={slot.width}
                    height={slot.height}
                    scale={scale}
                    bitmapCache={bitmapCache}
                    onPageRendered={onPageRendered}
                    onPageError={onPageError}
                  />
                  {renderedPages.has(slot.pageNumber) && (
                    <PdfPageTextLayer
                      document={document}
                      pageNumber={slot.pageNumber}
                      scale={scale}
                    />
                  )}
                  <PdfHighlightOverlay highlights={highlightsByPage?.get(slot.pageNumber) ?? []} />
                </div>
              ) : null}
            </PdfPageSlot>
          );
        })}
      </div>
    </div>
  );
}
