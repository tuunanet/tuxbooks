import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface PdfPresentationBarProps {
  pageNumber: number;
  pageCount: number;
  onPrev: () => void;
  onNext: () => void;
  onExit?: () => void;
}

/**
 * Presentation-mode controls (issue #65): a small floating bar at the
 * bottom edge of the document — prev/next, the page indicator, exit — so
 * the fullscreen reading workflow stays pointer-accessible while the
 * normal reader chrome (header, footer, sidebar) is hidden. The page fills
 * the viewport height, so keyboard navigation (Space/PageDown/arrows) is
 * the primary path; the bar is only the fallback.
 *
 * The bar stays out of the way: it is transparent until the pointer is over
 * it (or a control inside it has keyboard focus), so a presentation shows
 * the page alone and the controls return on hover.
 */
export function PdfPresentationBar({
  pageNumber,
  pageCount,
  onPrev,
  onNext,
  onExit,
}: PdfPresentationBarProps) {
  return (
    <div className="group fixed bottom-2 left-1/2 z-20 -translate-x-1/2 p-2">
      <div
        data-testid="pdf-presentation-bar"
        className="flex items-center gap-1 rounded-full border border-[var(--reader-chrome-border,var(--border))] bg-[var(--reader-chrome-surface,var(--background))]/90 px-2 py-1 opacity-0 shadow-lg backdrop-blur transition-opacity duration-200 group-hover:opacity-100 focus-within:opacity-100"
      >
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="pdf-pres-prev"
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
          data-testid="pdf-pres-next"
          aria-label="Next page"
          disabled={pageNumber >= pageCount}
          onClick={onNext}
        >
          <span aria-hidden="true">›</span>
        </Button>

        <span
          className="mx-1 h-4 w-px bg-[var(--reader-chrome-border,var(--border))]"
          aria-hidden="true"
        />

        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="pdf-pres-exit"
          aria-label="Exit presentation mode (Esc)"
          onClick={onExit}
        >
          <X />
        </Button>
      </div>
    </div>
  );
}
