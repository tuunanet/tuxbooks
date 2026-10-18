import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { PdfHighlightOverlay } from "@/components/reader/pdf/PdfHighlightOverlay";
import { EMPTY_HIGHLIGHT_OVERRIDES } from "@/lib/highlightPalette";
import { makeAnnotation } from "./factories";

/** The overlay draws one rect div per annotation rect (docs/PDF.md). */
function firstRectStyle(container: HTMLElement): string {
  return container.querySelector<HTMLElement>("[data-pdf-highlight]")!.getAttribute("style") ?? "";
}

describe("PdfHighlightOverlay", () => {
  it("multiplies the wash into light pages and composites normally on dark", () => {
    const highlight = makeAnnotation({ kind: "highlight", color: "yellow" });

    const light = render(
      <PdfHighlightOverlay
        highlights={[highlight]}
        family="light"
        overrides={EMPTY_HIGHLIGHT_OVERRIDES}
      />,
    );
    expect(firstRectStyle(light.container)).toContain("rgba(255, 189, 26, 0.42)");
    expect(firstRectStyle(light.container)).toContain("mix-blend-mode: multiply");
    light.unmount();

    const dark = render(
      <PdfHighlightOverlay
        highlights={[highlight]}
        family="dark"
        overrides={EMPTY_HIGHLIGHT_OVERRIDES}
      />,
    );
    expect(firstRectStyle(dark.container)).toContain("rgba(255, 193, 7, 0.32)");
    expect(firstRectStyle(dark.container)).toContain("mix-blend-mode: normal");
    dark.unmount();
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
    expect(firstRectStyle(container)).toContain("rgba(45, 212, 191, 0.28)");
    unmount();
  });
});
