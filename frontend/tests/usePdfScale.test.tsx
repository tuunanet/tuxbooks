import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

import { usePdfScale } from "@/components/reader/pdf/hooks/usePdfScale";
import type { PdfScaleRequest } from "@/components/reader/pdf/pdfLayout";

/**
 * The zoom commit is only atomic if the layout scale is derived in the same
 * commit as the zoom request. A scale that lands one commit late paints the
 * old layout for a frame after the wheel preview transform is dropped, which
 * is the jump seen on every ctrl+wheel commit.
 */
describe("usePdfScale", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(720);
  });

  afterEach(() => vi.restoreAllMocks());

  it("derives the new scale in the render that carries the new request", () => {
    const containerRef = { current: document.createElement("div") };
    const log: { level: number; scale: number }[] = [];

    function Probe({ request }: { request: PdfScaleRequest }) {
      const { scale, contentAreaRef } = usePdfScale(request, containerRef);
      log.push({ level: request.level, scale });
      return <div ref={contentAreaRef} />;
    }

    const request = (level: number): PdfScaleRequest => ({
      mode: "custom",
      level,
      reference: { width: 612, height: 792 },
      presentationPage: null,
    });

    const view = render(<Probe request={request(1)} />);
    log.length = 0;
    view.rerender(<Probe request={request(2)} />);

    expect(log.filter((entry) => entry.level === 2 && entry.scale !== 2)).toEqual([]);
    expect(log.at(-1)).toEqual({ level: 2, scale: 2 });
  });
});
