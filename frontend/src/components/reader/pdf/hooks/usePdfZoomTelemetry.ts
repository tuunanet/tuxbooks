import { useEffect, useRef, type RefObject } from "react";

import { isPdfZoomTelemetryEnabled, recordPdfZoomSample } from "@/lib/pdf/pdfZoomTelemetry";

import type { PdfAnchorInfo } from "./usePdfScrollTracking";
import type { PdfViewport } from "./usePdfViewport";

export interface PdfZoomTelemetryArgs {
  scrollContainerRef?: RefObject<HTMLElement | null>;
  documentRef?: RefObject<HTMLElement | null>;
  scale: number;
  zoomMode: string;
  zoomLevel: number;
  currentPage: number;
  /** The rAF-coalesced scroll viewport: a change means a scroll sample. */
  viewport: PdfViewport;
  anchorInfoRef?: RefObject<PdfAnchorInfo | null>;
  /** Last action that requested a zoom: wheel, keyboard-step, typed, fit, ... */
  triggerRef?: RefObject<string>;
  /** Cursor position of a wheel zoom, viewport-relative. */
  pointerRef?: RefObject<{ x: number; y: number } | null>;
}

/**
 * Records one sample per committed layout change and per scroll frame while
 * telemetry is enabled (see `pdfZoomTelemetry`). It is a no-op otherwise, and
 * the flag is re-checked each run so it can be switched on in a running app
 * without a rebuild.
 */
export function usePdfZoomTelemetry(args: PdfZoomTelemetryArgs): void {
  const lastScaleRef = useRef<number | null>(null);
  const lastDocumentRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isPdfZoomTelemetryEnabled()) return;
    const container = args.scrollContainerRef?.current ?? null;
    const documentEl = args.documentRef?.current ?? null;
    if (!container || !documentEl) return;

    const first = lastScaleRef.current === null;
    const scaleChanged = !first && lastScaleRef.current !== args.scale;
    const documentChanged = lastDocumentRef.current !== documentEl;
    lastScaleRef.current = args.scale;
    lastDocumentRef.current = documentEl;

    const containerRect = container.getBoundingClientRect();
    const documentRect = documentEl.getBoundingClientRect();
    const scrollTop = container.scrollTop;
    const scrollLeft = container.scrollLeft;
    const documentTop = documentRect.top - containerRect.top + scrollTop;
    const documentLeft = documentRect.left - containerRect.left + scrollLeft;
    const centerScrollX = scrollLeft + container.clientWidth / 2;
    const centerScrollY = scrollTop + container.clientHeight / 2;
    const centerLocalX = centerScrollX - documentLeft;
    const centerLocalY = centerScrollY - documentTop;
    const safeScale = args.scale > 0 ? args.scale : 1;

    const anchor = args.anchorInfoRef?.current ?? null;
    const pointer = args.pointerRef?.current ?? null;
    const wrapper =
      documentEl.querySelector<HTMLElement>(`[data-pdf-page-wrapper="${args.currentPage}"]`) ??
      documentEl.querySelector<HTMLElement>("[data-pdf-page-wrapper]");
    const canvas = wrapper?.querySelector("canvas") ?? null;
    const slot = wrapper?.closest<HTMLElement>("[data-pdf-slot]");

    recordPdfZoomSample({
      type: first || documentChanged ? "initial" : scaleChanged ? "zoom" : "scroll",
      trigger: first || scaleChanged ? (args.triggerRef?.current ?? "") : "",
      zoomMode: args.zoomMode,
      zoomLevel: args.zoomLevel,
      scale: args.scale,
      scrollTop,
      scrollLeft,
      clientWidth: container.clientWidth,
      clientHeight: container.clientHeight,
      scrollWidth: container.scrollWidth,
      scrollHeight: container.scrollHeight,
      documentTop,
      documentLeft,
      documentWidth: documentRect.width,
      documentHeight: documentRect.height,
      centerScrollX,
      centerScrollY,
      centerLocalX,
      centerLocalY,
      centerPageUnitsX: centerLocalX / safeScale,
      centerPageUnitsY: centerLocalY / safeScale,
      anchorPage: anchor?.page ?? null,
      anchorFraction: anchor?.fraction ?? null,
      policy:
        documentEl
          .closest<HTMLElement>("[data-testid=pdf-reader]")
          ?.getAttribute("data-pdf-scroll-policy") ?? "",
      pointerX: pointer?.x ?? null,
      pointerY: pointer?.y ?? null,
      canvasQuality: canvas?.getAttribute("data-pdf-render-quality") ?? null,
      canvasPosition: canvas?.style.position ?? "",
      canvasLeft: canvas?.style.left ?? "",
      canvasTop: canvas?.style.top ?? "",
      canvasTransform: canvas?.style.transform ?? "",
      canvasBuffer: canvas ? `${canvas.width}x${canvas.height}` : "",
      canvasRegion: canvas?.getAttribute("data-pdf-render-region") ?? "",
      slotRenderState: slot?.getAttribute("data-render-state") ?? null,
    });
  }, [
    args.scrollContainerRef,
    args.documentRef,
    args.scale,
    args.zoomMode,
    args.zoomLevel,
    args.currentPage,
    args.viewport,
    args.anchorInfoRef,
    args.triggerRef,
    args.pointerRef,
  ]);
}
