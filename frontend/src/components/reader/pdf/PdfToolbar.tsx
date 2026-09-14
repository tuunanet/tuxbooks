import {
  Maximize,
  Minus,
  Plus,
  Presentation,
  StretchHorizontal,
  StretchVertical,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ZoomMode } from "./pdfLayout";

interface PdfToolbarProps {
  pageNumber: number;
  pageCount: number;
  /** The active zoom mode (fit-* are dynamic; custom is a fixed level). */
  zoomMode: ZoomMode;
  /** Effective zoom percentage (scale × 100). */
  zoomPercent: number;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onPrev: () => void;
  onNext: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Resets to 100% (the zoom indicator doubles as the reset control). */
  onResetZoom: () => void;
  onFitPage: () => void;
  onFitWidth: () => void;
  onFitHeight: () => void;
  /** Toggles presentation mode (Ctrl+L); omitted when unsupported. */
  onTogglePresentation?: () => void;
  presentationActive?: boolean;
}

/**
 * PDF document controls: page navigation (`‹ Page 1 of 991 ›`), the zoom
 * cluster (`− % +`, the indicator doubles as the Ctrl+0 reset), the fit
 * modes (page/width/height, issue #65), and the presentation-mode toggle —
 * one compact group docked into the shell's reader header via a portal
 * (issue #68), so no dedicated control row takes vertical space from the
 * pages. Fit modes show their active state via `aria-pressed`. Native
 * `title` tooltips instead of the Radix Tooltip: the toolbar also renders
 * standalone (inline fallback without a shell host), where no
 * TooltipProvider exists.
 */
export function PdfToolbar({
  pageNumber,
  pageCount,
  zoomMode,
  zoomPercent,
  canZoomIn,
  canZoomOut,
  onPrev,
  onNext,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onFitPage,
  onFitWidth,
  onFitHeight,
  onTogglePresentation,
  presentationActive = false,
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
        aria-label="Zoom out (Ctrl+-)"
        disabled={!canZoomOut}
        onClick={onZoomOut}
      >
        <Minus />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="pdf-zoom-reset"
        aria-label={`Zoom level ${zoomPercent}% — reset to 100% (Ctrl+0)`}
        className="w-12 text-xs text-[var(--reader-chrome-muted,var(--muted-foreground))] tabular-nums"
        onClick={onResetZoom}
      >
        {zoomPercent}%
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="pdf-zoom-in"
        aria-label="Zoom in (Ctrl++)"
        disabled={!canZoomIn}
        onClick={onZoomIn}
      >
        <Plus />
      </Button>

      <Button
        variant="ghost"
        size="icon-sm"
        title="Fit page (Ctrl+1)"
        data-testid="pdf-fit-page"
        aria-label="Fit page (Ctrl+1)"
        aria-pressed={zoomMode === "fit-page"}
        onClick={onFitPage}
      >
        <Maximize />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title="Fit width (Ctrl+2)"
        data-testid="pdf-fit-width"
        aria-label="Fit width (Ctrl+2)"
        aria-pressed={zoomMode === "fit-width"}
        onClick={onFitWidth}
      >
        <StretchHorizontal />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title="Fit height (Ctrl+3)"
        data-testid="pdf-fit-height"
        aria-label="Fit height (Ctrl+3)"
        aria-pressed={zoomMode === "fit-height"}
        onClick={onFitHeight}
      >
        <StretchVertical />
      </Button>

      {onTogglePresentation && (
        <Button
          variant="ghost"
          size="icon-sm"
          title="Presentation mode (Ctrl+L)"
          data-testid="pdf-presentation-toggle"
          aria-label="Presentation mode (Ctrl+L)"
          aria-pressed={presentationActive}
          onClick={onTogglePresentation}
        >
          <Presentation />
        </Button>
      )}
    </div>
  );
}
