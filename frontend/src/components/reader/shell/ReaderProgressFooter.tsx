import type { RefObject } from "react";
import { Slider as SliderPrimitive } from "radix-ui";

interface ReaderProgressFooterProps {
  presentation: boolean;
  isEpub: boolean;
  position: number;
  progressPreview: number | null;
  onPreviewChange: (value: number | null) => void;
  onCommit: (value: number) => void;
  label: string | null;
  onLabelChange: (label: string | null) => void;
  onReadLabel: (percent: number) => void;
  progressBarRef: RefObject<HTMLDivElement | null>;
  onReleaseFocus: () => void;
}

/**
 * Progress footer: EPUB only. A fixed-layout PDF has no meaningful "percent
 * read", so the PDF reader shows no bottom bar at all; the scrolled EPUB flow
 * keeps an always-visible bar stacked below the document. The bar is a
 * slider: clicking (or dragging and releasing) it maps that book fraction
 * through the engine's position list. Dragging previews on a local value;
 * only the release commits a navigation.
 */
export function ReaderProgressFooter({
  presentation,
  isEpub,
  position,
  progressPreview,
  onPreviewChange,
  onCommit,
  label,
  onLabelChange,
  onReadLabel,
  progressBarRef,
  onReleaseFocus,
}: ReaderProgressFooterProps) {
  if (presentation || !isEpub) return null;
  return (
    <footer
      data-testid="reader-footer"
      data-progress-visible="true"
      className="shrink-0 border-t border-[var(--reader-chrome-border,var(--border))] px-4 py-2"
    >
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        <SliderPrimitive.Root
          ref={progressBarRef}
          data-testid="reader-progress"
          className="relative flex w-full touch-none select-none items-center"
          value={[progressPreview ?? position]}
          min={0}
          max={100}
          step={0.1}
          onValueChange={(values) => {
            const next = values[0] ?? 0;
            onPreviewChange(next);
            onReadLabel(next);
          }}
          onValueCommit={(values) => {
            const committed = values[0] ?? 0;
            onPreviewChange(null);
            onCommit(committed);
            onReadLabel(committed);
          }}
          onPointerEnter={() => onReadLabel(progressPreview ?? position)}
          onPointerDown={() => onReadLabel(progressPreview ?? position)}
          onPointerLeave={() => onLabelChange(null)}
          // A pointer seek is over: hand focus back to the reading surface, so
          // arrows and space go straight back to turning pages instead of
          // nudging the thumb by 0.1% per keypress (the same focus policy as
          // the navigation drawer). Keyboard steering from a Tab-focused thumb
          // keeps its steps. pointercancel counts too: a gesture cut short by
          // an alt-tab or a touch handoff must not leave the thumb holding the
          // reading keys.
          onPointerUp={onReleaseFocus}
          onPointerCancel={onReleaseFocus}
        >
          {label !== null && (
            <span
              data-testid="reader-progress-tooltip"
              className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-foreground px-2 py-1 text-xs text-background"
              style={{ left: `${progressPreview ?? position}%` }}
            >
              {label}
            </span>
          )}
          <SliderPrimitive.Track
            data-slot="slider-track"
            className="relative h-1 grow overflow-hidden rounded-full bg-[var(--reader-progress-track,var(--muted))]"
          >
            <SliderPrimitive.Range
              data-slot="slider-range"
              className="absolute h-full bg-[var(--reader-progress-fill,var(--primary))]"
            />
          </SliderPrimitive.Track>
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            aria-label="Reading position"
            className="block size-3.5 shrink-0 cursor-pointer rounded-full border border-[var(--reader-chrome-border,var(--border))] bg-[var(--reader-chrome-card,var(--muted-foreground))] shadow focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--reader-progress-fill,var(--primary))]"
          />
        </SliderPrimitive.Root>
        <span
          data-testid="reader-position"
          className="w-10 text-right text-xs text-[var(--reader-chrome-muted,var(--muted-foreground))] tabular-nums"
        >
          {Math.round(progressPreview ?? position)}%
        </span>
      </div>
    </footer>
  );
}
