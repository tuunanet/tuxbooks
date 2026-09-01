import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PdfToolbarProps {
  pageNumber: number;
  pageCount: number;
  zoomPercent: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onPrev: () => void;
  onNext: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

/**
 * PDF reader toolbar: page navigation, page indicator, and zoom. Rendered
 * sticky so the controls stay reachable while the document scrolls.
 */
export function PdfToolbar({
  pageNumber,
  pageCount,
  zoomPercent,
  canZoomIn,
  canZoomOut,
  onPrev,
  onNext,
  onZoomIn,
  onZoomOut,
}: PdfToolbarProps) {
  return (
    <div className="sticky top-0 z-10 -mx-2 mb-3 flex items-center gap-1 bg-background/95 px-2 py-1">
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="pdf-prev"
        aria-label="Previous page"
        disabled={pageNumber <= 1}
        onClick={onPrev}
      >
        <span aria-hidden="true">‹</span>
      </Button>
      <span
        data-testid="pdf-page-indicator"
        aria-live="polite"
        className="px-2 text-xs text-muted-foreground tabular-nums"
      >
        Page {pageNumber} of {pageCount}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="pdf-next"
        aria-label="Next page"
        disabled={pageNumber >= pageCount}
        onClick={onNext}
      >
        <span aria-hidden="true">›</span>
      </Button>

      <span className="mx-2 h-4 w-px bg-border" aria-hidden="true" />

      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="pdf-zoom-out"
        aria-label="Zoom out"
        disabled={!canZoomOut}
        onClick={onZoomOut}
      >
        <Minus />
      </Button>
      <span
        data-testid="pdf-zoom-level"
        className="w-10 text-center text-xs text-muted-foreground tabular-nums"
      >
        {zoomPercent}%
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="pdf-zoom-in"
        aria-label="Zoom in"
        disabled={!canZoomIn}
        onClick={onZoomIn}
      >
        <Plus />
      </Button>
    </div>
  );
}
