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
 * PDF document controls: page navigation (`‹ Page 1 of 991 ›`) and zoom
 * (`− 75% +`), one compact group docked into the shell's reader header via
 * a portal (issue #68) — no dedicated control row above the document, so
 * the freed vertical space goes to the pages. Two clearly separated
 * clusters with a small divider: prev/next stay grouped around the page
 * indicator, zoom out/level/in stay grouped together.
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
    <div
      data-testid="pdf-toolbar"
      role="group"
      aria-label="Page navigation and zoom"
      className="flex items-center gap-1"
    >
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
        className="whitespace-nowrap px-2 text-xs text-[var(--reader-chrome-muted,var(--muted-foreground))] tabular-nums"
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

      <span
        className="mx-2 h-4 w-px bg-[var(--reader-chrome-border,var(--border))]"
        aria-hidden="true"
      />

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
        className="w-10 text-center text-xs text-[var(--reader-chrome-muted,var(--muted-foreground))] tabular-nums"
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
