import { describe, expect, it } from "vite-plus/test";
import { render } from "@testing-library/react";

import { PdfHighlightOverlay } from "@/components/reader/pdf/PdfHighlightOverlay";
import { EMPTY_HIGHLIGHT_OVERRIDES } from "@/lib/highlightPalette";
import { makeAnnotation } from "./factories";

/**
 * The overlay must composite one wash per annotation: selection rects overlap
 * at line boundaries, and per-rect translucent + multiplied fills darken the
 * overlaps into seams. The group carries the wash alpha and the blend mode
 * once; the rects inside are solid.
 */
function groupOf(container: HTMLElement, id: number): HTMLElement {
  const group = container.querySelector<HTMLElement>(`[data-pdf-highlight-group="${id}"]`);
  expect(group).not.toBeNull();
  return group!;
}

describe("PdfHighlightOverlay", () => {
  it("multiplies one wash per annotation into light pages", () => {
    const highlight = makeAnnotation({ kind: "highlight", color: "yellow" });
    const { container, unmount } = render(
      <PdfHighlightOverlay
        highlights={[highlight]}
        family="light"
        overrides={EMPTY_HIGHLIGHT_OVERRIDES}
      />,
    );

    const group = groupOf(container, highlight.id);
    expect(group.style.opacity).toBe("0.42");
    expect(group.style.mixBlendMode).toBe("multiply");

    const rects = group.querySelectorAll<HTMLElement>("[data-pdf-highlight]");
    expect(rects.length).toBeGreaterThan(0);
    for (const rect of rects) {
      // Solid fills: overlapping rects inside the group cannot darken.
      expect(rect.style.background).not.toContain("rgba");
      expect(rect.style.mixBlendMode).toBe("");
      expect(rect.style.opacity).toBe("");
    }
    unmount();
  });

  it("composites normally on dark pages", () => {
    const highlight = makeAnnotation({ kind: "highlight", color: "yellow" });
    const { container, unmount } = render(
      <PdfHighlightOverlay
        highlights={[highlight]}
        family="dark"
        overrides={EMPTY_HIGHLIGHT_OVERRIDES}
      />,
    );

    const group = groupOf(container, highlight.id);
    expect(group.style.opacity).toBe("0.32");
    expect(group.style.mixBlendMode).toBe("normal");
    unmount();
  });

  it("paints an override hue instead of the default ink", () => {
    const highlight = makeAnnotation({ kind: "highlight", color: "purple" });
    const { container, unmount } = render(
      <PdfHighlightOverlay
        highlights={[highlight]}
        family="light"
        overrides={{ light: { purple: "#2dd4bf" }, dark: {} }}
      />,
    );

    const group = groupOf(container, highlight.id);
    expect(group.style.opacity).toBe("0.28");
    const rect = group.querySelector<HTMLElement>("[data-pdf-highlight]")!;
    expect(rect.style.background).toBe("rgb(45, 212, 191)");
    unmount();
  });

  it("keeps annotations in separate groups", () => {
    const first = makeAnnotation({ kind: "highlight", color: "green" });
    const second = makeAnnotation({ kind: "highlight", color: "red" });
    const { container, unmount } = render(
      <PdfHighlightOverlay
        highlights={[first, second]}
        family="light"
        overrides={EMPTY_HIGHLIGHT_OVERRIDES}
      />,
    );

    expect(groupOf(container, first.id).querySelectorAll("[data-pdf-highlight]").length).toBe(1);
    expect(groupOf(container, second.id).querySelectorAll("[data-pdf-highlight]").length).toBe(1);
    unmount();
  });
});
