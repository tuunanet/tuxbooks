import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { EpubSectionProgress } from "@/lib/epub/readiumEngine";

interface EpubPresentationBarProps {
  /** Spine position of the reading point; null until the first relocate. */
  section: EpubSectionProgress | null;
  onPrev: () => void;
  onNext: () => void;
  onExit?: () => void;
}

/**
 * Presentation-mode controls (issue #64): the EPUB twin of the PDF bar
 * (issue #65) — a small floating bar at the bottom edge of the document
 * with prev/next engine page turns, the spine indicator, and exit, so the
 * fullscreen workflow stays pointer-accessible while the normal reader
 * chrome (header, footer) is hidden. Keyboard navigation (arrows, space,
 * PageUp/PageDown) is the primary path; the bar is only the fallback.
 */
export function EpubPresentationBar({ section, onPrev, onNext, onExit }: EpubPresentationBarProps) {
  return (
    <div
      data-testid="epub-presentation-bar"
      className="fixed bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full border border-[var(--reader-chrome-border,var(--border))] bg-[var(--reader-chrome-surface,var(--background))]/90 px-2 py-1 shadow-lg backdrop-blur"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="epub-pres-prev"
        aria-label="Previous page"
        onClick={onPrev}
      >
        <span aria-hidden="true">‹</span>
      </Button>
      <span
        data-testid="epub-section-indicator"
        aria-live="polite"
        className="whitespace-nowrap px-2 text-xs text-[var(--reader-chrome-muted,var(--muted-foreground))] tabular-nums"
      >
        {section !== null ? `Section ${section.current + 1} of ${section.total}` : "…"}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="epub-pres-next"
        aria-label="Next page"
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
        data-testid="epub-pres-exit"
        aria-label="Exit presentation mode (Esc)"
        onClick={onExit}
      >
        <X />
      </Button>
    </div>
  );
}
