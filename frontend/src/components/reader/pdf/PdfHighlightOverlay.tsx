import type { Annotation } from "@/types/domain";
import { annotationRects, highlightCssColor } from "../annotationModel";

/**
 * Drawn highlights for one page: absolutely positioned translucent rects in
 * normalized page space, so they track the canvas exactly at every zoom.
 * Pointer-transparent — they must never block text selection.
 */
export function PdfHighlightOverlay({ highlights }: { highlights: Annotation[] }) {
  const drawn = highlights.flatMap((highlight) =>
    annotationRects(highlight).map((rect, index) => ({ highlight, rect, index })),
  );
  if (drawn.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0" data-pdf-highlights="">
      {drawn.map(({ highlight, rect, index }) => (
        <div
          key={`${highlight.id}:${index}`}
          data-pdf-highlight={highlight.id}
          className="absolute"
          style={{
            left: `${rect.x * 100}%`,
            top: `${rect.y * 100}%`,
            width: `${rect.width * 100}%`,
            height: `${rect.height * 100}%`,
            background: highlightCssColor(highlight.color),
            opacity: 0.35,
            mixBlendMode: "multiply",
          }}
        />
      ))}
    </div>
  );
}
