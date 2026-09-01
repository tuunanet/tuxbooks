import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/pdf/pdfEngine", () => ({
  openPdfDocument: vi.fn(),
  closePdfDocument: vi.fn(async () => {}),
  pdfWorkerSrc: vi.fn(() => "/assets/pdf.worker.min.mjs"),
  RenderingCancelledException: class RenderingCancelledException extends Error {},
}));

import { PdfReader } from "@/components/reader/pdf/PdfReader";
import { closePdfDocument, openPdfDocument } from "@/lib/pdf/pdfEngine";
import { ShortcutProvider } from "@/state/ShortcutProvider";
import { ReaderProvider } from "@/state/ReaderProvider";
import { makeBook } from "./factories";
import { scrollTo, stubScrollGeometry } from "./mocks/dom";
import { fireIntersection, intersectionObservers } from "./mocks/intersectionObserver";
import { invokeMock, mockInvoke } from "./mocks/tauri";
import { makeFakePdfDocument } from "./mocks/pdfEngine";

const openDocumentMock = vi.mocked(openPdfDocument);
const closeDocumentMock = vi.mocked(closePdfDocument);

type EngineDocument = Awaited<ReturnType<typeof openPdfDocument>>;

/** Fire a visibility change on the hook's visible-viewport observer. */
function fireVisible(element: Element, isIntersecting: boolean): void {
  const [visibleObserver] = intersectionObservers();
  if (!visibleObserver) throw new Error("visible observer not created yet");
  fireIntersection(visibleObserver, element, isIntersecting);
}

/** Fire a visibility change on the hook's preload observer. */
function firePreload(element: Element, isIntersecting: boolean): void {
  const [, preloadObserver] = intersectionObservers();
  if (!preloadObserver) throw new Error("preload observer not created yet");
  fireIntersection(preloadObserver, element, isIntersecting);
}

const pdfBook = makeBook({
  id: 7,
  format: "pdf",
  path: "/tmp/library/minimal.pdf",
  title: "A Minimal PDF",
});

function renderPdfReader(
  props: {
    onDocumentLoad?: (count: number) => void;
    scrollContainerRef?: RefObject<HTMLElement | null>;
  } = {},
) {
  return render(
    <ShortcutProvider>
      <ReaderProvider>
        <PdfReader
          book={pdfBook}
          onDocumentLoad={props.onDocumentLoad}
          scrollContainerRef={props.scrollContainerRef}
        />
      </ReaderProvider>
    </ShortcutProvider>,
  );
}

async function renderLoadedReader(props: { onDocumentLoad?: (count: number) => void } = {}) {
  const view = renderPdfReader(props);
  await screen.findByTestId("pdf-canvas");
  return view;
}

function slot(pageNumber: number): HTMLElement | null {
  return document.querySelector(`[data-pdf-slot="${pageNumber}"]`);
}

/** Page numbers of the currently mounted canvases, sorted as strings. */
function canvasPages(): string[] {
  return screen
    .getAllByTestId("pdf-canvas")
    .map((canvas) => canvas.getAttribute("data-pdf-page") ?? "")
    .sort();
}

beforeEach(() => {
  invokeMock.mockReset();
  openDocumentMock.mockReset();
  closeDocumentMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PdfReader loading", () => {
  it("fetches the book bytes and renders page one at 100%", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();

    expect(invokeMock).toHaveBeenCalledWith("get_book_bytes", { bookId: 7 });
    expect(openDocumentMock).toHaveBeenCalledTimes(1);
    const [firstCall] = openDocumentMock.mock.calls;
    expect(firstCall?.[0]).toBeInstanceOf(Uint8Array);
    expect(doc.getPage).toHaveBeenCalledWith(1);
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3");

    const canvas = await screen.findByTestId("pdf-canvas");
    // Backing-store attributes are set when the first render blits, a beat
    // after the canvas element mounts.
    await waitFor(() => expect(canvas).toHaveAttribute("width", "612"));
    expect(canvas).toHaveAttribute("height", "792");
    expect(canvas).toHaveAttribute("data-pdf-page", "1");
    await waitFor(() => expect(slot(1)).toHaveAttribute("data-render-state", "rendered"));
    // Scale-1 viewport calls, in order: geometry reference (page 1), then
    // the page-1 canvas render. Further pages measure when they approach
    // visibility (see the virtualization suite).
    expect(doc.scales).toEqual([1, 1]);
  });

  it("shows the loading state until the document and layout are ready", async () => {
    let resolveDocument: (value: EngineDocument) => void = () => {};
    openDocumentMock.mockReturnValue(
      new Promise((resolve) => {
        resolveDocument = resolve as (value: EngineDocument) => void;
      }) as never,
    );
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    renderPdfReader();
    expect(await screen.findByTestId("pdf-loading")).toHaveTextContent("Loading A Minimal PDF…");
    expect(screen.queryByTestId("pdf-canvas")).not.toBeInTheDocument();

    resolveDocument(makeFakePdfDocument(3) as unknown as EngineDocument);
    expect(await screen.findByTestId("pdf-canvas")).toBeInTheDocument();
  });

  it("renders one slot per page with the loading slot marked", async () => {
    const doc = makeFakePdfDocument(100);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();

    expect(document.querySelectorAll("[data-pdf-slot]")).toHaveLength(100);
    // Only the active page owns a canvas; the rest are geometry-only slots.
    expect(screen.getAllByTestId("pdf-canvas")).toHaveLength(1);
    await waitFor(() => expect(slot(1)).toHaveAttribute("data-render-state", "rendered"));
    expect(slot(2)).toHaveAttribute("data-render-state", "unloaded");
    expect(slot(100)).toHaveAttribute("data-render-state", "unloaded");
  });

  it("lays out mixed page sizes and corrects estimates on measurement", async () => {
    const doc = makeFakePdfDocument(3, (pageNumber) =>
      pageNumber === 2 ? { width: 792, height: 612 } : { width: 612, height: 792 },
    );
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();

    // Page 2 approaches visibility: the preload set measures it and mounts
    // its canvas, and the slot corrects from the 612x792 estimate to the
    // real landscape size while its siblings keep theirs.
    firePreload(slot(2) as Element, true);
    await waitFor(() => expect(slot(2)).toHaveStyle({ width: "792px", height: "612px" }));
    expect(slot(1)).toHaveStyle({ width: "612px", height: "792px" });
    expect(slot(3)).toHaveStyle({ width: "612px", height: "792px" });
    expect(slot(2)?.style.marginTop).toBe("8px");
    expect(canvasPages()).toEqual(["1", "2"]);
  });

  it("reports the loaded page count to the shell", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    const onDocumentLoad = vi.fn();
    await renderLoadedReader({ onDocumentLoad });

    expect(onDocumentLoad).toHaveBeenCalledWith(3);
  });

  it("shows an honest error when the bytes cannot be loaded", async () => {
    mockInvoke({ get_book_bytes: new Error("file went away") });

    renderPdfReader();

    expect(await screen.findByTestId("pdf-error")).toHaveTextContent(
      "This PDF could not be opened: file went away",
    );
    expect(screen.queryByTestId("pdf-canvas")).not.toBeInTheDocument();
  });

  it("destroys the document when the reader unmounts", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    const view = await renderLoadedReader();
    view.unmount();

    expect(closeDocumentMock).toHaveBeenCalledWith(doc);
  });
});

describe("PdfReader virtualization", () => {
  it("renders pages as they become visible and preloads the surroundings", async () => {
    const doc = makeFakePdfDocument(100);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    // Before any intersection events, only the current page has a canvas.
    expect(canvasPages()).toEqual(["1"]);

    fireVisible(slot(2) as Element, true);
    fireVisible(slot(3) as Element, true);
    firePreload(slot(4) as Element, true);
    firePreload(slot(5) as Element, true);

    // Completed canvases stay mounted; only ONE prerender page beyond the
    // visible range is attempted (the closest, page 4 — like the official
    // viewer's single pre-render slot).
    await waitFor(() => expect(canvasPages()).toEqual(["1", "2", "3", "4"]));
    await waitFor(() => expect(slot(3)).toHaveAttribute("data-render-state", "rendered"));
    expect(slot(5)).toHaveAttribute("data-render-state", "unloaded");
    // Approaching pages are measured so their geometry is real before use.
    expect(doc.getPage).toHaveBeenCalledWith(4);
  });

  it("renders one page at a time, reading anchor first", async () => {
    const doc = makeFakePdfDocument(100, undefined, { holdRenderFor: [1] });
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    expect(canvasPages()).toEqual(["1"]);

    // While the anchor page's render is in flight, newly visible pages must
    // not start their own renders (the worker is serial — queueing behind
    // invisible work is what made image-heavy pages take seconds).
    fireVisible(slot(3) as Element, true);
    expect(canvasPages()).toEqual(["1"]);

    doc.releaseRender(1);
    await waitFor(() => expect(canvasPages()).toEqual(["1", "3"]));

    // With nothing visible pending, a single prerender page is allowed.
    firePreload(slot(7) as Element, true);
    await waitFor(() => expect(canvasPages()).toEqual(["1", "3", "7"]));
  });

  it("evicts canvases once pages leave the preload window", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(100) as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    fireVisible(slot(2) as Element, true);
    firePreload(slot(3) as Element, true);
    await waitFor(() => expect(canvasPages()).toEqual(["1", "2", "3"]));

    fireVisible(slot(2) as Element, false);
    firePreload(slot(2) as Element, false);
    fireVisible(slot(3) as Element, false);
    firePreload(slot(3) as Element, false);

    await waitFor(() => expect(canvasPages()).toEqual(["1"]));
    // Evicted pages keep their reserved geometry as honest unloaded slots.
    expect(slot(2)).toHaveAttribute("data-render-state", "unloaded");
    expect(slot(2)).toHaveStyle({ height: "792px" });
  });

  it("caps active canvases at the render budget, closest pages first", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(100) as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    for (let page = 1; page <= 20; page++) {
      fireVisible(slot(page) as Element, true);
    }

    await waitFor(() => expect(canvasPages()).toHaveLength(8));
    expect(canvasPages()).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
    expect(slot(20)).toHaveAttribute("data-render-state", "unloaded");
  });
});

describe("PdfReader scroll tracking", () => {
  /** Loaded reader with a fake scroll container (720px viewport). */
  async function renderScrollableReader() {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });
    const container = document.createElement("div");
    const view = renderPdfReader({ scrollContainerRef: { current: container } });
    await screen.findByTestId("pdf-canvas");
    stubScrollGeometry(container, screen.getByTestId("pdf-document"));
    return { view, container };
  }

  it("reports the anchor page to the shell without re-anchoring", async () => {
    const scrollIntoViewSpy = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    try {
      const { container } = await renderScrollableReader();
      expect(await screen.findByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3");
      scrollIntoViewSpy.mockClear();

      // Anchor = scrollTop + 25% of the 720px viewport; 810 + 180 lands in
      // page 2, 1620 + 180 in page 3, and back to 0 in page 1.
      scrollTo(container, 810);
      await waitFor(() =>
        expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
      );
      scrollTo(container, 1620);
      await waitFor(() =>
        expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 3"),
      );
      scrollTo(container, 0);
      await waitFor(() =>
        expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3"),
      );

      // The scroll itself is the navigation: the reader must not scroll back.
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    } finally {
      scrollIntoViewSpy.mockRestore();
    }
  });

  it("re-anchors on external navigation after scroll-driven changes", async () => {
    const scrollIntoViewSpy = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    try {
      const { container } = await renderScrollableReader();
      await screen.findByTestId("pdf-page-indicator");
      scrollTo(container, 810);
      await waitFor(() =>
        expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
      );
      scrollIntoViewSpy.mockClear();

      // Toolbar navigation is external: the reader scrolls to page 3's top.
      await userEvent.click(screen.getByTestId("pdf-next"));
      await waitFor(() =>
        expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 3"),
      );
      expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
      expect(scrollIntoViewSpy.mock.contexts[0]).toBe(slot(3));
    } finally {
      scrollIntoViewSpy.mockRestore();
    }
  });
});

describe("PdfReader persistence", () => {
  function progressRoutes(savedPage: number | null) {
    return {
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress:
        savedPage === null
          ? null
          : {
              bookId: 7,
              chapterHref: null,
              characterOffset: null,
              pageNumber: savedPage,
              scrollOffset: null,
              progressPercent: null,
              updatedAt: "2026-01-01T00:00:00Z",
            },
      save_reading_progress: null,
    };
  }

  it("restores the saved page straight into the interactive view", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke(progressRoutes(3));
    const scrollIntoViewSpy = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});

    try {
      renderPdfReader();

      // The restored page renders directly — no page-one flash first.
      await waitFor(() =>
        expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "3"),
      );
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 3");
      expect(doc.getPage).toHaveBeenCalledWith(3);
      expect(scrollIntoViewSpy.mock.contexts[0]).toBe(slot(3));
    } finally {
      scrollIntoViewSpy.mockRestore();
    }
  });

  it("starts at page one when no progress exists", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke(progressRoutes(null));

    renderPdfReader();

    await screen.findByTestId("pdf-canvas");
    expect(await screen.findByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3");
  });

  it("ignores out-of-range saved pages instead of restoring them", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    mockInvoke(progressRoutes(99));

    renderPdfReader();

    await screen.findByTestId("pdf-canvas");
    expect(await screen.findByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3");
  });

  it("saves position changes debounced, not on every scroll", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke(progressRoutes(null));

    await renderLoadedReader();
    invokeMock.mockClear();

    await userEvent.click(screen.getByTestId("pdf-next"));
    // The write is debounced (1s): it must not appear immediately.
    expect(invokeMock).not.toHaveBeenCalledWith(
      "save_reading_progress",
      expect.objectContaining({ bookId: 7 }),
    );
    await waitFor(
      () =>
        expect(invokeMock).toHaveBeenCalledWith("save_reading_progress", {
          bookId: 7,
          progress: { pageNumber: 2, progressPercent: 50 },
        }),
      { timeout: 3000 },
    );
  });

  it("flushes the final position when the reader closes mid-debounce", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke(progressRoutes(null));

    const view = await renderLoadedReader();
    await userEvent.click(screen.getByTestId("pdf-next"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );

    invokeMock.mockClear();
    view.unmount();

    expect(invokeMock).toHaveBeenCalledWith("save_reading_progress", {
      bookId: 7,
      progress: { pageNumber: 2, progressPercent: 50 },
    });
  });
});

describe("PdfReader fit width and zoom anchoring", () => {
  it("renders at the fit-width scale of the content area", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();

    // A 1224px-wide content area fits the 612pt reference page at 2×.
    const area = screen.getByTestId("pdf-content-area");
    Object.defineProperty(area, "clientWidth", { value: 1224, configurable: true });
    window.dispatchEvent(new Event("resize"));

    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", "1224"));
    expect(slot(1)).toHaveStyle({ width: "1224px" });
    expect(screen.getByTestId("pdf-zoom-level")).toHaveTextContent("100%");
  });

  it("recomputes the fit scale when the window resizes", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    const area = screen.getByTestId("pdf-content-area");
    Object.defineProperty(area, "clientWidth", { value: 1224, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", "1224"));

    Object.defineProperty(area, "clientWidth", { value: 918, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", "918"));
  });

  it("preserves the reading spot within the page across zoom changes", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });
    const container = document.createElement("div");
    const view = renderPdfReader({ scrollContainerRef: { current: container } });
    await screen.findByTestId("pdf-canvas");
    stubScrollGeometry(container, screen.getByTestId("pdf-document"));

    // Anchor sits 35% into page 2 (anchor = 900 + 180 = 1080; page 2 spans
    // 800..1592 → fraction 280/792).
    scrollTo(container, 900);
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );

    // Zoom to 150%: page 2 moves to top 1196 (scaled height 1188 + the
    // unscaled 8px gap); the anchor must land at 1196 + 0.3535…*1188 = 1616
    // → scrollTop = 1616 - 180 = 1436. The in-page fraction is preserved
    // exactly.
    await userEvent.click(screen.getByTestId("pdf-zoom-in"));
    await waitFor(() => expect(container.scrollTop).toBe(1436));
    expect(screen.getByTestId("pdf-zoom-level")).toHaveTextContent("150%");
    view.unmount();
  });

  it("zooms from the keyboard with + and -", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    fireEvent.keyDown(window, { key: "+" });
    expect(screen.getByTestId("pdf-zoom-level")).toHaveTextContent("150%");
    fireEvent.keyDown(window, { key: "-" });
    expect(screen.getByTestId("pdf-zoom-level")).toHaveTextContent("100%");
    fireEvent.keyDown(window, { key: "-" });
    expect(screen.getByTestId("pdf-zoom-level")).toHaveTextContent("75%");
  });
});

describe("PdfReader navigation", () => {
  it("navigates with prev/next and disables at both bounds", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    const prev = screen.getByTestId("pdf-prev");
    const next = screen.getByTestId("pdf-next");
    expect(prev).toBeDisabled();

    await userEvent.click(next);
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "2"),
    );
    expect(doc.getPage).toHaveBeenCalledWith(2);
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3");
    // The previous slot keeps its geometry without a canvas.
    expect(slot(1)).toHaveAttribute("data-render-state", "unloaded");

    await userEvent.click(next);
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "3"),
    );
    expect(next).toBeDisabled();

    await userEvent.click(prev);
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "2"),
    );
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3");
  });
});

describe("PdfReader zoom", () => {
  it("re-anchors the active page slot when the zoom changes", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });
    const scrollIntoViewSpy = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});

    try {
      await renderLoadedReader();

      // Land on page 2 first (navigation re-anchors; clear that call).
      await userEvent.click(screen.getByTestId("pdf-next"));
      await waitFor(() =>
        expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "2"),
      );
      scrollIntoViewSpy.mockClear();

      // Zooming rescales every slot: the active page must be scrolled back
      // into view, or the viewport lands on a stale offset showing an
      // unloaded slot while the indicator still names the page.
      await userEvent.click(screen.getByTestId("pdf-zoom-in"));
      expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
      expect(scrollIntoViewSpy.mock.contexts[0]).toBe(slot(2));
      expect(scrollIntoViewSpy.mock.calls[0]?.[0]).toEqual({
        block: "start",
        inline: "nearest",
      });

      // Pure page-state churn (render completion) must not re-anchor.
      scrollIntoViewSpy.mockClear();
      await waitFor(() => expect(slot(2)).toHaveAttribute("data-render-state", "rendered"));
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    } finally {
      scrollIntoViewSpy.mockRestore();
    }
  });

  it("never paints a superseded render over the current one (scroll artifact race)", async () => {
    // getPage calls are gated so we control resolution order across effect
    // generations: geometry init, the first canvas render, then the render
    // re-triggered by a zoom change.
    const gatedPage = {
      getViewport: vi.fn(({ scale }: { scale: number }) => ({
        width: 612 * scale,
        height: 792 * scale,
      })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
    };
    const pending: Array<(page: unknown) => void> = [];
    const gatedDoc = {
      numPages: 3,
      getPage: vi.fn(() => new Promise((resolve) => pending.push(resolve))),
    };

    openDocumentMock.mockResolvedValue(gatedDoc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    renderPdfReader();
    await waitFor(() => expect(pending).toHaveLength(1));
    (pending.shift() as (page: unknown) => void)(gatedPage); // geometry init → layout ready

    await screen.findByTestId("pdf-canvas"); // canvas mounted, render gated
    expect(pending).toHaveLength(1);
    const [staleRender] = pending.splice(0) as [(page: unknown) => void];

    // Zoom supersedes the in-flight render: cleanup runs for the first
    // effect, and the second effect requests the page again.
    await userEvent.click(screen.getByTestId("pdf-zoom-in"));
    expect(pending).toHaveLength(1);
    const [freshRender] = pending.splice(0) as [(page: unknown) => void];

    // The NEWER render resolves first and paints at 150%…
    freshRender(gatedPage);
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", String(612 * 1.5)),
    );
    expect(gatedPage.render).toHaveBeenCalledTimes(1);

    // …then the STALE one resolves. It must not cancel the fresh render or
    // paint old-scale content over the resized canvas (real-world symptom:
    // mirrored page fragments blitted over pages while scrolling).
    staleRender(gatedPage);
    await waitFor(() => expect(gatedPage.render).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", String(612 * 1.5));
  });

  it("steps through fixed zoom levels and re-renders the viewport", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    expect(screen.getByTestId("pdf-zoom-level")).toHaveTextContent("100%");
    expect(screen.getByTestId("pdf-zoom-out")).toBeEnabled();

    await userEvent.click(screen.getByTestId("pdf-zoom-in"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", String(612 * 1.5)),
    );
    expect(screen.getByTestId("pdf-zoom-level")).toHaveTextContent("150%");
    expect(doc.scales).toContain(1.5);
    // Zoom rescales the whole document layout, not just the canvas.
    expect(slot(1)).toHaveStyle({ width: "918px" });
    expect(slot(3)).toHaveStyle({ height: "1188px" });

    await userEvent.click(screen.getByTestId("pdf-zoom-in"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", String(612 * 2)),
    );
    expect(screen.getByTestId("pdf-zoom-in")).toBeDisabled();

    await userEvent.click(screen.getByTestId("pdf-zoom-out"));
    await userEvent.click(screen.getByTestId("pdf-zoom-out"));
    await userEvent.click(screen.getByTestId("pdf-zoom-out"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", String(612 * 0.75)),
    );
    expect(screen.getByTestId("pdf-zoom-level")).toHaveTextContent("75%");
  });
});
