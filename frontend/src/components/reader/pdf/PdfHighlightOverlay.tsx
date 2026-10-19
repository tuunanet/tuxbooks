import type { Annotation } from "@/types/domain";
import { annotationRects } from "../annotationModel";
import {
  highlightInk,
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
 * Persisted highlights over the page canvas: absolutely positioned rects in
 * normalized page space, so they track the canvas at every zoom.
 * Pointer-transparent — clicks resolve through the selection handler
 * (docs/PDF.md).
 *
 * Each annotation paints as one group: solid rects inside, with the wash
 * alpha and the blend applied once to the group. Selection rects overlap at
 * line boundaries, and translucent multiplied rects stacked directly would
 * darken every overlap into a seam. Light pages multiply the wash into the
 * paper; dark treatments would pull multiply toward mud, so they composite
 * normally.
 */
export function PdfHighlightOverlay({ highlights, family, overrides }: PdfHighlightOverlayProps) {
  const groups = highlights
    .map((highlight) => ({ highlight, rects: annotationRects(highlight) }))
    .filter((group) => group.rects.length > 0);
  if (groups.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0" data-pdf-highlights="">
      {groups.map(({ highlight, rects }) => {
        const ink = highlightInk(highlight.color, family, overrides);
        return (
          <div
            key={highlight.id}
            data-pdf-highlight-group={highlight.id}
            className="absolute inset-0"
            style={{
              opacity: ink.alpha,
              mixBlendMode: family === "dark" ? "normal" : "multiply",
            }}
          >
            {rects.map((rect, index) => (
              <div
                key={`${highlight.id}:${index}`}
                data-pdf-highlight={highlight.id}
                className="absolute"
                style={{
                  left: `${rect.x * 100}%`,
                  top: `${rect.y * 100}%`,
                  width: `${rect.width * 100}%`,
                  height: `${rect.height * 100}%`,
                  background: ink.hex,
                }}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
