import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMemo } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PdfSidebar } from "@/components/reader/pdf/PdfSidebar";
import { estimatePageSizes } from "@/components/reader/pdf/pdfLayout";
import { makeFakePdfDocument } from "./mocks/pdfEngine";
import { fireIntersection, intersectionObservers } from "./mocks/intersectionObserver";

const LETTER = { width: 612, height: 792 };

function fireVisible(element: Element, isIntersecting: boolean): void {
  const [visibleObserver] = intersectionObservers();
  if (!visibleObserver) throw new Error("visible observer not created yet");
  fireIntersection(visibleObserver, element, isIntersecting);
}

function firePreload(element: Element, isIntersecting: boolean): void {
  const [, preloadObserver] = intersectionObservers();
  if (!preloadObserver) throw new Error("preload observer not created yet");
  fireIntersection(preloadObserver, element, isIntersecting);
}

function slot(pageNumber: number): HTMLElement {
  const element = document.querySelector(`[data-pdf-thumb-slot="${pageNumber}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`thumbnail slot ${pageNumber} missing`);
  return element;
}

function thumbnailPages(): string[] {
  return screen
    .getAllByTestId("pdf-thumbnail")
    .map((canvas) => canvas.getAttribute("data-pdf-page") ?? "")
    .sort((a, b) => Number(a) - Number(b));
}

interface RenderOptions {
  pageCount?: number;
  currentPage?: number;
  failOnceFor?: number[];
}

function renderSidebar({ pageCount = 100, currentPage = 1, failOnceFor = [] }: RenderOptions = {}) {
  const doc = makeFakePdfDocument(pageCount, undefined, { failOnceFor });
  const measurePages = vi.fn();
  const onNavigate = vi.fn();
  render(
    <PdfSidebar
      document={doc as unknown as Parameters<typeof PdfSidebar>[0]["document"]}
      sizes={estimatePageSizes(pageCount, LETTER)}
      currentPage={currentPage}
      measurePages={measurePages}
      onNavigate={onNavigate}
    />,
  );
  return { doc, measurePages, onNavigate };
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PdfSidebar virtualization", () => {
  it("reserves a cell per page and renders only the current page before any scroll", async () => {
    renderSidebar({ pageCount: 100 });

    expect(document.querySelectorAll("[data-pdf-thumb-slot]")).toHaveLength(100);
    // The reading page's thumbnail paints immediately (anchor fallback), the
    // rest stay unloaded geometry.
    expect(thumbnailPages()).toEqual(["1"]);
    expect(slot(100)).toHaveAttribute("data-thumb-state", "unloaded");
    await waitFor(() => expect(slot(1)).toHaveAttribute("data-thumb-state", "rendered"));
  });

  it("renders visible thumbnails first, one prerender at a time", async () => {
    renderSidebar({ pageCount: 100 });

    fireVisible(slot(5), true);
    fireVisible(slot(6), true);
    fireVisible(slot(7), true);
    firePreload(slot(8), true);

    // Page 1 completed before the window moved, so it is evicted: completed
    // canvases stay mounted only while their page stays in the window.
    await waitFor(() => expect(thumbnailPages()).toEqual(["5", "6", "7", "8"]));
    // Low-resolution: the thumbnail renders at cell width / page width scale;
    // the backing store floors the fractional 612·(112/612) viewport.
    expect(screen.getAllByTestId("pdf-thumbnail")[0]).toHaveAttribute("width", "111");
  });

  it("caps mounted thumbnails at the render budget", async () => {
    renderSidebar({ pageCount: 100 });

    for (let page = 1; page <= 20; page++) fireVisible(slot(page), true);

    await waitFor(() => expect(thumbnailPages()).toHaveLength(12));
    expect(slot(20)).toHaveAttribute("data-thumb-state", "unloaded");
  });

  it("evicts thumbnails that leave the window", async () => {
    renderSidebar({ pageCount: 100 });

    fireVisible(slot(2), true);
    await waitFor(() => expect(thumbnailPages()).toContain("2"));

    fireVisible(slot(2), false);
    await waitFor(() => expect(thumbnailPages()).not.toContain("2"));
    // The cell keeps its reserved geometry.
    expect(slot(2)).toHaveAttribute("data-thumb-state", "unloaded");
    expect(slot(2)).toHaveAttribute("data-pdf-thumb-slot", "2");
  });

  it("measures approaching pages so mixed-size aspects correct", async () => {
    const { measurePages } = renderSidebar({ pageCount: 100 });

    fireVisible(slot(3), true);
    firePreload(slot(4), true);

    await waitFor(() => expect(measurePages).toHaveBeenCalled());
    const measured = measurePages.mock.calls.at(-1)?.[0] as number[];
    expect(measured).toContain(3);
    expect(measured).toContain(4);
  });
});

describe("PdfSidebar current-page indication", () => {
  it("marks and follows the current page from outside scrolls", async () => {
    const view = render(<Fixture current={1} />);

    const active = slot(1).querySelector("button");
    expect(active).toHaveAttribute("aria-current", "true");
    expect(slot(1)).toHaveAttribute("data-thumb-active");

    view.rerender(<Fixture current={7} />);
    await waitFor(() =>
      expect(slot(7).querySelector("button")).toHaveAttribute("aria-current", "true"),
    );
    expect(slot(1)).not.toHaveAttribute("data-thumb-active");
    // The list follows the reading position without jumping it to an edge.
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({
      block: "nearest",
      inline: "nearest",
    });
  });

  it("does not re-scroll when the change came from clicking a thumbnail", async () => {
    const onNavigate = vi.fn();
    const view = render(<Fixture current={1} onNavigate={onNavigate} />);
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();

    await userEvent.click(slot(3).querySelector("button") as HTMLButtonElement);
    expect(onNavigate).toHaveBeenCalledWith(3);

    view.rerender(<Fixture current={3} onNavigate={onNavigate} />);
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("navigates to the clicked page", async () => {
    const { onNavigate } = renderSidebar({ pageCount: 100, currentPage: 1 });

    await userEvent.click(slot(50).querySelector("button") as HTMLButtonElement);
    expect(onNavigate).toHaveBeenCalledWith(50);
    expect(slot(50).querySelector("button")).toHaveAttribute("aria-label", "Go to page 50");
  });
});

describe("PdfSidebar failures", () => {
  it("flags a failed thumbnail without breaking the sidebar", async () => {
    renderSidebar({ pageCount: 100, failOnceFor: [2] });

    fireVisible(slot(2), true);

    await waitFor(() => expect(slot(2)).toHaveAttribute("data-thumb-state", "error"));
    // The other cells keep working.
    fireVisible(slot(3), true);
    await waitFor(() => expect(slot(3)).toHaveAttribute("data-thumb-state", "rendered"));
  });
});

/** Direct-render fixture so rerender can drive the current page. */
function Fixture({
  current,
  onNavigate = () => {},
}: {
  current: number;
  onNavigate?: (page: number) => void;
}) {
  const doc = useMemo(() => makeFakePdfDocument(10), []);
  return (
    <PdfSidebar
      document={doc as unknown as Parameters<typeof PdfSidebar>[0]["document"]}
      sizes={estimatePageSizes(10, LETTER)}
      currentPage={current}
      measurePages={() => {}}
      onNavigate={onNavigate}
    />
  );
}
