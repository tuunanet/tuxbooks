import type { Annotation } from "@/types/domain";
import { annotationRects } from "../annotationModel";
import {
  highlightCss,
  type HighlightOverrides,
  type HighlightThemeFamily,
} from "@/lib/highlightPalette";

interface PdfHighlightOverlayProps {
  highlights: Annotation[];
  /** Theme family of the active reader theme; picks the wash set + blend. */
  family: HighlightThemeFamily;
  /** Per-family hue overrides (lib/highlightPalette). */
  overrides: HighlightOverrides;
}

/**
 * Persisted highlights over the page canvas: absolutely positioned
 * translucent rects in normalized page space, so they track the canvas at
 * every zoom. Pointer-transparent — clicks resolve through the selection
 * handler (docs/PDF.md). Light pages multiply the wash into the paper; on
 * dark treatments multiply would pull it toward mud, so it composites
 * normally there.
 */
export function PdfHighlightOverlay({ highlights, family, overrides }: PdfHighlightOverlayProps) {
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
            background: highlightCss(highlight.color, family, overrides),
            mixBlendMode: family === "dark" ? "normal" : "multiply",
          }}
        />
      ))}
    </div>
  );
}
