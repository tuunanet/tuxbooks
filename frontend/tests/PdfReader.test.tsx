import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@/lib/pdf/pdfEngine", async () => {
  const { findPageMatches } = await import("@/lib/pdf/pdfSearch");
  return {
    openPdfDocument: vi.fn(),
    closePdfDocument: vi.fn(async () => {}),
    getPdfOutline: vi.fn(async () => []),
    getPdfPageText: vi.fn(async () => ""),
    findPageMatches,
    pdfWorkerSrc: vi.fn(() => "/assets/pdf.worker.min.mjs"),
    isRenderingCancelled: vi.fn(() => false),
  };
});

import { PdfReader } from "@/components/reader/pdf/PdfReader";
import {
  closePdfDocument,
  getPdfOutline,
  getPdfPageText,
  openPdfDocument,
} from "@/lib/pdf/pdfEngine";
import { ShortcutProvider } from "@/state/ShortcutProvider";
import { ReaderProvider } from "@/state/ReaderProvider";
import { makeBook } from "./factories";
import type { Book } from "@/types/domain";
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

interface PdfReaderProps {
  book?: Book;
  onDocumentLoad?: (count: number) => void;
  onOutlineLoad?: (outline: { title: string; page: number | null; items: unknown[] }[]) => void;
  sidebarHost?: HTMLElement | null;
  scrollContainerRef?: RefObject<HTMLElement | null>;
  searchTargetRef?: { current: unknown };
  onSearchGroup?: (bookId: number, group: unknown) => void;
  onSearchDone?: (bookId: number) => void;
}

function renderPdfReader(props: PdfReaderProps = {}) {
  const view = render(readerTree(props));
  return {
    ...view,
    rerenderBook(next: PdfReaderProps) {
      view.rerender(readerTree({ ...props, ...next }));
    },
  };
}

function readerTree(props: PdfReaderProps) {
  return (
    <ShortcutProvider>
      <ReaderProvider>
        <PdfReader
          book={props.book ?? pdfBook}
          onDocumentLoad={props.onDocumentLoad}
          onOutlineLoad={props.onOutlineLoad}
          sidebarHost={props.sidebarHost}
          scrollContainerRef={props.scrollContainerRef}
          searchTargetRef={props.searchTargetRef as never}
          onSearchGroup={props.onSearchGroup as never}
          onSearchDone={props.onSearchDone}
        />
      </ReaderProvider>
    </ShortcutProvider>
  );
}

async function renderLoadedReader(
  props: {
    book?: Book;
    onDocumentLoad?: (count: number) => void;
    onOutlineLoad?: (outline: { title: string; page: number | null; items: unknown[] }[]) => void;
    sidebarHost?: HTMLElement | null;
  } = {},
) {
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

describe("PdfReader book switching", () => {
  const secondBook = makeBook({
    id: 8,
    format: "pdf",
    path: "/tmp/library/second.pdf",
    title: "A Second PDF",
  });

  it("destroys the old document and opens the next one when the book changes", async () => {
    const docA = makeFakePdfDocument(3);
    const docB = makeFakePdfDocument(5);
    openDocumentMock.mockResolvedValueOnce(docA as unknown as EngineDocument);
    openDocumentMock.mockResolvedValueOnce(docB as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    const view = await renderLoadedReader();
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3");

    view.rerenderBook({ book: secondBook });

    // The previous document is destroyed the moment the book changes, and
    // its reading surface leaves instead of lingering while the next loads.
    expect(closeDocumentMock).toHaveBeenCalledWith(docA);
    expect(await screen.findByTestId("pdf-loading")).toBeInTheDocument();
    await screen.findByTestId("pdf-canvas");
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 5");
    expect(invokeMock).toHaveBeenCalledWith("get_book_bytes", { bookId: 8 });
    expect(openDocumentMock).toHaveBeenCalledTimes(2);
    expect(closeDocumentMock).toHaveBeenCalledTimes(1);
  });

  it("never mounts a load that finishes after the book changed", async () => {
    let resolveFirst: (doc: EngineDocument) => void = () => {};
    openDocumentMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve as (doc: EngineDocument) => void;
        }) as never,
    );
    const docB = makeFakePdfDocument(5);
    openDocumentMock.mockResolvedValueOnce(docB as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    const view = renderPdfReader();
    expect(await screen.findByTestId("pdf-loading")).toBeInTheDocument();
    view.rerenderBook({ book: secondBook });
    await screen.findByTestId("pdf-canvas");
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 5");

    // The superseded document resolves late: it must be destroyed, never
    // mounted, and never reported as the shell's page count.
    const lateDocument = makeFakePdfDocument(7);
    resolveFirst(lateDocument as unknown as EngineDocument);
    await waitFor(() => expect(closeDocumentMock).toHaveBeenCalledWith(lateDocument));
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 5");
    expect(closeDocumentMock).toHaveBeenCalledTimes(1);
  });

  it("render bookkeeping and the bitmap cache never survive a document switch", async () => {
    const docA = makeFakePdfDocument(4);
    const docB = makeFakePdfDocument(6, undefined, { holdRenderFor: [1, 2] });
    openDocumentMock.mockResolvedValueOnce(docA as unknown as EngineDocument);
    openDocumentMock.mockResolvedValueOnce(docB as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    const view = await renderLoadedReader();
    // Widen the window to pages 1–2 and let both complete, so the previous
    // document leaves rendered marks and cached bitmaps behind.
    firePreload(slot(2) as Element, true);
    await waitFor(() => expect(slot(2)).toHaveAttribute("data-render-state", "rendered"));
    expect(screen.getByTestId("pdf-reader")).toHaveAttribute("data-pdf-bitmap-cache", "2:3877632");

    view.rerenderBook({ book: secondBook });
    await screen.findAllByTestId("pdf-canvas");

    // The new document's pages 1–2 are in-flight again (held by the fake):
    // stale "rendered" marks must not report them done, and the cache must
    // start empty — the previous book's pixels never leak into this one.
    expect(slot(1)).toHaveAttribute("data-render-state", "rendering");
    expect(slot(2)).toHaveAttribute("data-render-state", "rendering");
    expect(screen.getByTestId("pdf-reader")).toHaveAttribute("data-pdf-bitmap-cache", "0:0");
    expect(screen.getAllByTestId("pdf-canvas")).toHaveLength(2);

    docB.releaseRender(1);
    docB.releaseRender(2);
    await waitFor(() => expect(slot(1)).toHaveAttribute("data-render-state", "rendered"));
    await waitFor(() => expect(slot(2)).toHaveAttribute("data-render-state", "rendered"));
  });
});

describe("PdfReader outline and thumbnails", () => {
  it("reports the engine outline once the document loads", async () => {
    const outline = [{ title: "Part One", page: 1, items: [] }];
    vi.mocked(getPdfOutline).mockResolvedValueOnce(outline as never);
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    const onOutlineLoad = vi.fn();
    await renderLoadedReader({ onOutlineLoad });

    expect(getPdfOutline).toHaveBeenCalledWith(expect.objectContaining({ numPages: 3 }));
    await waitFor(() => expect(onOutlineLoad).toHaveBeenCalledWith(outline));
  });

  it("degrades outline failures to an empty outline", async () => {
    vi.mocked(getPdfOutline).mockRejectedValueOnce(new Error("outline boom"));
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    const onOutlineLoad = vi.fn();
    await renderLoadedReader({ onOutlineLoad });

    await waitFor(() => expect(onOutlineLoad).toHaveBeenCalledWith([]));
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3");
  });

  it("renders thumbnails into the provided sidebar host", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    const host = document.createElement("aside");
    document.body.appendChild(host);
    const view = await renderLoadedReader({ sidebarHost: host });
    try {
      // The whole document reserves thumbnail cells; the current page paints.
      expect(host.querySelectorAll("[data-pdf-thumb-slot]")).toHaveLength(3);
      await waitFor(() =>
        expect(host.querySelector('[data-pdf-thumb-slot="1"]')).toHaveAttribute(
          "data-thumb-state",
          "rendered",
        ),
      );
      expect(host.querySelector('[data-pdf-thumb-slot="1"] button')).toHaveAttribute(
        "aria-current",
        "true",
      );

      // A thumbnail click navigates the reader.
      await userEvent.click(
        host.querySelector('[data-pdf-thumb-slot="3"] button') as HTMLButtonElement,
      );
      await waitFor(() =>
        expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 3"),
      );
      expect(host.querySelector('[data-pdf-thumb-slot="3"] button')).toHaveAttribute(
        "aria-current",
        "true",
      );
    } finally {
      view.unmount();
      host.remove();
    }
  });

  it("does not render a sidebar without a host", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    expect(document.querySelector("[data-testid=pdf-thumbnails]")).toBeNull();
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

  it("renders up to two pages concurrently, anchor first", async () => {
    const doc = makeFakePdfDocument(100, undefined, { holdRenderFor: [1] });
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    expect(canvasPages()).toEqual(["1"]);

    // PDF.js pipelines pages: each page's operator list is produced
    // independently in the worker and each paint loop time-slices on the
    // main thread, so while the anchor's heavy raster is held, the next
    // visible page starts instead of waiting behind it (a heavy page 1
    // must never starve page 2).
    fireVisible(slot(3) as Element, true);
    await waitFor(() => expect(canvasPages()).toEqual(["1", "3"]));

    // The concurrency budget is full: a further visible page waits.
    fireVisible(slot(4) as Element, true);
    expect(canvasPages()).toEqual(["1", "3"]);

    // Completing a render frees its slot for the next priority page.
    doc.releaseRender(1);
    await waitFor(() => expect(canvasPages()).toEqual(["1", "3", "4"]));

    // With nothing visible pending, a single prerender page is allowed.
    firePreload(slot(7) as Element, true);
    await waitFor(() => expect(canvasPages()).toEqual(["1", "3", "4", "7"]));
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

  it("blits a cached bitmap on window re-entry instead of re-rendering", async () => {
    const doc = makeFakePdfDocument(100);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    fireVisible(slot(2) as Element, true);
    await waitFor(() => expect(slot(2)).toHaveAttribute("data-render-state", "rendered"));

    const page2GetPageCalls = () => doc.getPage.mock.calls.filter(([page]) => page === 2).length;
    const callsBeforeEviction = page2GetPageCalls();
    expect(callsBeforeEviction).toBeGreaterThan(0);
    // Diagnostics: both rendered pages are retained in the bitmap cache.
    expect(screen.getByTestId("pdf-reader").getAttribute("data-pdf-bitmap-cache")).toMatch(/^2:/);

    // Eviction unmounts the canvas, but its pixels move into the cache.
    fireVisible(slot(2) as Element, false);
    firePreload(slot(2) as Element, false);
    await waitFor(() => expect(canvasPages()).not.toContain("2"));

    // Re-entry blits the retained bitmap: the slot reports rendered again
    // without a second engine page request or raster.
    fireVisible(slot(2) as Element, true);
    await waitFor(() => expect(slot(2)).toHaveAttribute("data-render-state", "rendered"));
    expect(page2GetPageCalls()).toBe(callsBeforeEviction);
  });

  it("invalidates cached bitmaps on zoom so re-entry re-renders at the new scale", async () => {
    const doc = makeFakePdfDocument(100);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    fireVisible(slot(2) as Element, true);
    await waitFor(() => expect(slot(2)).toHaveAttribute("data-render-state", "rendered"));

    const page2GetPageCalls = () => doc.getPage.mock.calls.filter(([page]) => page === 2).length;

    fireVisible(slot(2) as Element, false);
    firePreload(slot(2) as Element, false);
    await waitFor(() => expect(canvasPages()).not.toContain("2"));
    const callsBeforeZoom = page2GetPageCalls();

    // Cached bitmaps are scale-keyed and dropped on zoom: re-entry must go
    // back to the engine rather than blit a stale-scale bitmap.
    await userEvent.click(screen.getByTestId("pdf-zoom-in"));
    fireVisible(slot(2) as Element, true);
    await waitFor(() => expect(slot(2)).toHaveAttribute("data-render-state", "rendered"));
    expect(page2GetPageCalls()).toBeGreaterThan(callsBeforeZoom);
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

describe("PdfReader hardening", () => {
  it("shows a retryable page-level error without breaking the document", async () => {
    const doc = makeFakePdfDocument(3, undefined, { failOnceFor: [2] });
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();

    // Page 2 fails: its own slot reports the failure with a retry action…
    await userEvent.click(screen.getByTestId("pdf-next"));
    expect(await screen.findByTestId("pdf-retry-2")).toBeInTheDocument();
    expect(slot(2)).toHaveAttribute("data-render-state", "error");

    // …while the rest of the document keeps working.
    await userEvent.click(screen.getByTestId("pdf-next"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "3"),
    );

    // Retry re-renders the failed page (the fake fails once, then succeeds).
    await userEvent.click(screen.getByTestId("pdf-prev"));
    await userEvent.click(await screen.findByTestId("pdf-retry-2"));
    await waitFor(() => expect(slot(2)).toHaveAttribute("data-render-state", "rendered"));
    expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "2");
  });

  it("cancels an in-flight render when the reader unmounts", async () => {
    const doc = makeFakePdfDocument(3, undefined, { holdRenderFor: [1] });
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    const view = await renderLoadedReader();
    expect(doc.cancelledPages).not.toContain(1);

    view.unmount();
    expect(doc.cancelledPages).toContain(1);
  });

  it("clamps keyboard zoom at both bounds under rapid input", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    for (let i = 0; i < 6; i++) fireEvent.keyDown(window, { key: "-" });
    expect(screen.getByTestId("pdf-zoom-level")).toHaveTextContent("50%");
    expect(screen.getByTestId("pdf-zoom-out")).toBeDisabled();

    for (let i = 0; i < 10; i++) fireEvent.keyDown(window, { key: "+" });
    expect(screen.getByTestId("pdf-zoom-level")).toHaveTextContent("200%");
    expect(screen.getByTestId("pdf-zoom-in")).toBeDisabled();
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

describe("PdfReader in-book search", () => {
  it("streams per-page match groups and reports completion", async () => {
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });
    const doc = makeFakePdfDocument(2);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    vi.mocked(getPdfPageText).mockImplementation(async (_document, page) =>
      page === 1 ? "alpha beta gamma" : "delta beta epsilon",
    );

    const searchTargetRef: { current: { run: (q: string) => void } | null } = { current: null };
    const groups: Array<{ label: string; matches: unknown[] }> = [];
    let done = false;
    renderPdfReader({
      searchTargetRef,
      onSearchGroup: (_bookId, group) => groups.push(group as never),
      onSearchDone: () => {
        done = true;
      },
    });
    await screen.findByTestId("pdf-canvas");

    searchTargetRef.current!.run("beta");
    await waitFor(() => expect(groups).toHaveLength(2));
    expect(groups[0]).toEqual({
      label: "Page 1",
      matches: [{ cfi: null, page: 1, excerpt: { pre: "alpha ", match: "beta", post: " gamma" } }],
    });
    expect(groups[1]?.label).toBe("Page 2");
    await waitFor(() => expect(done).toBe(true));
  });

  it("drops the page-text cache when the document changes", async () => {
    mockInvoke({
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });
    const first = makeFakePdfDocument(1);
    const second = makeFakePdfDocument(1);
    openDocumentMock.mockResolvedValueOnce(first as unknown as EngineDocument);
    openDocumentMock.mockResolvedValueOnce(second as unknown as EngineDocument);
    vi.mocked(getPdfPageText).mockImplementation(async (_document, page) => `text ${page}`);

    const searchTargetRef: { current: { run: (q: string) => void } | null } = { current: null };
    const { rerenderBook } = renderPdfReader({ searchTargetRef, book: pdfBook });
    await screen.findByTestId("pdf-canvas");
    searchTargetRef.current!.run("text");
    await waitFor(() => expect(vi.mocked(getPdfPageText)).toHaveBeenCalled());

    rerenderBook({ searchTargetRef, book: { ...pdfBook, id: 8 } });
    await screen.findAllByTestId("pdf-canvas");
    searchTargetRef.current!.run("text");
    await waitFor(() =>
      expect(vi.mocked(getPdfPageText)).toHaveBeenCalledWith(
        second as unknown as EngineDocument,
        1,
      ),
    );
  });
});
