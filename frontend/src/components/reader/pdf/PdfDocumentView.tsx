import { useCallback } from "react";
import type { PdfDocument } from "@/lib/pdf/pdfEngine";
import { PdfPageCanvas } from "./PdfPageCanvas";
import { PdfPageSlot, type PdfPageLifecycle } from "./PdfPageSlot";
import type { LayoutSlot } from "./pdfLayout";

interface PdfDocumentViewProps {
  document: PdfDocument;
  slots: LayoutSlot[];
  /** The page the reading position currently names; it owns the canvas. */
  activePage: number;
  /** PDF.js render scale for the active page's canvas. */
  scale: number;
  renderedPages: ReadonlySet<number>;
  failedPages: ReadonlySet<number>;
  onPageRendered: (pageNumber: number) => void;
  onPageError: (pageNumber: number, error: unknown) => void;
  /** Registers the active page's slot element for scroll targeting. */
  registerActiveSlot: (element: HTMLDivElement | null) => void;
}

/**
 * The continuous document surface: one lightweight slot per page (the whole
 * document reserves its space up front), with a canvas only on the active
 * page. Slot geometry comes from the layout layer; DOM flow reproduces it
 * exactly, so computed offsets and real offsets never disagree.
 */
export function PdfDocumentView({
  document,
  slots,
  activePage,
  scale,
  renderedPages,
  failedPages,
  onPageRendered,
  onPageError,
  registerActiveSlot,
}: PdfDocumentViewProps) {
  const canvasFor = useCallback(
    (slot: LayoutSlot) => (
      <PdfPageCanvas
        document={document}
        pageNumber={slot.pageNumber}
        width={slot.width}
        height={slot.height}
        scale={scale}
        onPageRendered={onPageRendered}
        onPageError={onPageError}
      />
    ),
    [document, scale, onPageRendered, onPageError],
  );

  const documentWidth = slots.reduce((max, slot) => Math.max(max, slot.width), 0);

  return (
    <div className="flex min-h-0 w-full justify-center overflow-x-auto">
      <div
        data-testid="pdf-document"
        style={{ width: `${documentWidth}px` }}
        className="flex flex-col items-center"
      >
        {slots.map((slot, index) => {
          // The canvas lives only on the active page, so lifecycle states
          // beyond it stay honest: an inactive page is always unloaded.
          let state: PdfPageLifecycle = "unloaded";
          if (slot.pageNumber === activePage) {
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
              registerRef={slot.pageNumber === activePage ? registerActiveSlot : undefined}
            >
              {slot.pageNumber === activePage ? canvasFor(slot) : null}
            </PdfPageSlot>
          );
        })}
      </div>
    </div>
  );
}
