import { useEffect, useRef } from "react";
import { renderPdfTextLayer, type PdfDocument } from "@/lib/pdf/pdfEngine";
import "@/lib/pdf/pdfTextLayer.css";

interface PdfPageTextLayerProps {
  document: PdfDocument;
  pageNumber: number;
  /** PDF.js render scale (must match the page canvas viewport). */
  scale: number;
}

/**
 * The selectable text surface of one rendered page: transparent PDF.js text
 * spans positioned over the canvas. Purely an interaction affordance — text
 * selection for highlights — with no visuals of its own. Lives only on the
 * bounded render set (pages with canvases), so text extraction never runs
 * for distant pages.
 */
export function PdfPageTextLayer({ document, pageNumber, scale }: PdfPageTextLayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !document) return;
    let disposed = false;
    let active: { cancel(): void } | null = null;
    renderPdfTextLayer(document, pageNumber, container, scale)
      .then((layer) => {
        if (disposed) layer.cancel();
        else active = layer;
      })
      .catch((err: unknown) => {
        if (!disposed) console.warn(`text layer unavailable on page ${pageNumber}`, err);
      });
    return () => {
      disposed = true;
      active?.cancel();
      container.textContent = "";
    };
  }, [document, pageNumber, scale]);

  return <div ref={containerRef} className="textLayer" data-pdf-text-layer={pageNumber} />;
}
