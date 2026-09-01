import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { PAGE_GAP_PX, type LayoutSlot } from "./pdfLayout";

/**
 * A page slot's rendering lifecycle (§ page lifecycle). Slots keep their
 * geometry in every state so evicted canvases never collapse the layout.
 */
export type PdfPageLifecycle =
  "unloaded" | "queued" | "loading" | "rendering" | "rendered" | "error";

interface PdfPageSlotProps {
  slot: LayoutSlot;
  /** True for every slot except the first (the gap sits above it). */
  gapAbove: boolean;
  state: PdfPageLifecycle;
  /** Slot content: the page canvas when active, nothing while unloaded. */
  children?: ReactNode;
  /** Registers the slot element for visibility tracking and scroll targeting. */
  registerRef?: (element: HTMLDivElement | null) => void;
  /** Called when the user asks a failed page to render again. */
  onRetry?: () => void;
}

/**
 * Layout-only reservation for one page. The slot owns geometry and
 * visibility; whatever renders inside it is decoupled, so pages can
 * disappear from memory without collapsing the document. `scroll-mt` keeps
 * scroll targets clear of the sticky toolbar.
 */
export function PdfPageSlot({
  slot,
  gapAbove,
  state,
  children,
  registerRef,
  onRetry,
}: PdfPageSlotProps) {
  // Callers pass fresh closures per render; forwarding them directly would
  // re-run React's ref swap (null + element) on every render. The wrapper
  // keeps React ref churn to actual mount/unmount events, and re-invokes
  // the latest closure whenever it changes so consumers that depend on
  // identity (e.g. the anchor slot handed to scroll targeting) stay current.
  const elementRef = useRef<HTMLDivElement | null>(null);
  const registerRefRef = useRef(registerRef);
  useEffect(() => {
    if (registerRefRef.current !== registerRef) {
      registerRefRef.current = registerRef;
      registerRefRef.current?.(elementRef.current);
    }
  });
  const forwardRef = useCallback((element: HTMLDivElement | null) => {
    elementRef.current = element;
    registerRefRef.current?.(element);
  }, []);

  return (
    <div
      ref={forwardRef}
      data-pdf-slot={slot.pageNumber}
      data-render-state={state}
      style={{
        width: `${slot.width}px`,
        height: `${slot.height}px`,
        marginTop: gapAbove ? PAGE_GAP_PX : 0,
      }}
      className="shrink-0 scroll-mt-12"
    >
      {state === "error" ? (
        <div className="flex h-full flex-col items-center justify-center gap-3 rounded-sm border border-destructive/30 bg-destructive/5 px-4 text-center text-sm">
          <p>Unable to render page {slot.pageNumber}</p>
          {onRetry && (
            <Button
              variant="outline"
              size="sm"
              data-testid={`pdf-retry-${slot.pageNumber}`}
              onClick={onRetry}
            >
              Retry
            </Button>
          )}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
