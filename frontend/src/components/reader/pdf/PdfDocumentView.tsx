import { useMemo, type Ref } from "react";
import type { PdfDocument } from "@/lib/pdf/pdfEngine";
import { PdfPageCanvas } from "./PdfPageCanvas";
import { PdfPageSlot, type PdfPageLifecycle } from "./PdfPageSlot";
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
  onPageRendered: (pageNumber: number) => void;
  onPageError: (pageNumber: number, error: unknown) => void;
  registerSlot: (pageNumber: number, element: HTMLDivElement | null) => void;
  /** Registers the anchor page's slot element for scroll targeting. */
  registerAnchorSlot: (element: HTMLDivElement | null) => void;
  /** Receives the document element for scroll-position math. */
  documentRef?: Ref<HTMLDivElement>;
}

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
  onPageRendered,
  onPageError,
  registerSlot,
  registerAnchorSlot,
  documentRef,
}: PdfDocumentViewProps) {
  const canvasPages = useMemo(() => new Set(renderPages), [renderPages]);
  const documentWidth = slots.reduce((max, slot) => Math.max(max, slot.width), 0);

  return (
    <div className="flex min-h-0 w-full justify-center overflow-x-auto">
      <div
        ref={documentRef}
        data-testid="pdf-document"
        style={{ width: `${documentWidth}px` }}
        className="flex flex-col items-center"
      >
        {slots.map((slot, index) => {
          // Canvases live only on the render set, so lifecycle states stay
          // honest: a page outside the set is always unloaded, no matter
          // what it rendered before being evicted.
          let state: PdfPageLifecycle = "unloaded";
          if (canvasPages.has(slot.pageNumber)) {
            state = failedPages.has(slot.pageNumber)
              ? "error"
              : renderedPages.has(slot.pageNumber)
                ? "rendered"
                : "rendering";
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
            >
              {canvasPages.has(slot.pageNumber) ? (
                <PdfPageCanvas
                  document={document}
                  pageNumber={slot.pageNumber}
                  width={slot.width}
                  height={slot.height}
                  scale={scale}
                  onPageRendered={onPageRendered}
                  onPageError={onPageError}
                />
              ) : null}
            </PdfPageSlot>
          );
        })}
      </div>
    </div>
  );
}
