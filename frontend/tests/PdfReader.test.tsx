import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type RefObject } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/pdf/pdfEngine", async () => {
  const { findPageMatches } = await import("@/lib/pdf/pdfSearch");
  return {
    openPdfDocument: vi.fn(),
    openPdfDocumentFromBook: vi.fn(),
    prewarmPdfEngine: vi.fn(async () => {}),
    cancelPdfPrewarm: vi.fn(),
    closePdfDocument: vi.fn(async () => {}),
    getPdfOutline: vi.fn(async () => []),
    getPdfPageText: vi.fn(async () => ""),
    findPageMatches,
    pdfWorkerSrc: vi.fn(() => "/assets/pdf.worker.min.mjs"),
    isRenderingCancelled: vi.fn(() => false),
    renderPdfTextLayer: vi.fn(async () => ({ cancel: vi.fn() })),
  };
});

import { PdfReader } from "@/components/reader/pdf/PdfReader";
import type { ReaderSelection } from "@/components/reader/annotationModel";
import type { ReaderAdapter } from "@/components/reader/readerModel";
import {
  closePdfDocument,
  getPdfOutline,
  getPdfPageText,
  openPdfDocumentFromBook,
  renderPdfTextLayer,
} from "@/lib/pdf/pdfEngine";
import { ShortcutProvider } from "@/state/ShortcutProvider";
import { ReaderProvider } from "@/state/ReaderProvider";
import { useReader, type ReaderPreferences } from "@/state/readerState";
import { makeAnnotation, makeBook } from "./factories";
import type { Annotation } from "@/types/domain";
import type { Book } from "@/types/domain";
import { scrollTo, stubScrollGeometry } from "./mocks/dom";
import { fireIntersection, intersectionObservers } from "./mocks/intersectionObserver";
import { invokeMock, mockInvoke } from "./mocks/bridge";
import { makeFakePdfDocument } from "./mocks/pdfEngine";
import { displayedSizes, documentHeight, layoutSlots } from "@/components/reader/pdf/pdfLayout";
const openDocumentMock = vi.mocked(openPdfDocumentFromBook);
const closeDocumentMock = vi.mocked(closePdfDocument);

type EngineDocument = Awaited<ReturnType<typeof openPdfDocumentFromBook>>;

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
  controlsHost?: HTMLElement | null;
  scrollContainerRef?: RefObject<HTMLElement | null>;
  adapterRef?: { current: ReaderAdapter | null };
  onSearchGroup?: (bookId: number, group: unknown) => void;
  onSearchDone?: (bookId: number) => void;
  highlights?: Annotation[];
  onCreateHighlight?: (input: Record<string, unknown>) => void;
  onSelectionChange?: (selection: ReaderSelection | null) => void;
  presentationMode?: boolean;
  onExitPresentation?: () => void;
  onTogglePresentation?: () => void;
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
          controlsHost={props.controlsHost}
          scrollContainerRef={props.scrollContainerRef}
          adapterRef={props.adapterRef}
          onSearchGroup={props.onSearchGroup as never}
          onSearchDone={props.onSearchDone}
          highlights={props.highlights}
          onCreateHighlight={props.onCreateHighlight as never}
          onSelectionChange={props.onSelectionChange}
          presentationMode={props.presentationMode}
          onExitPresentation={props.onExitPresentation}
          onTogglePresentation={props.onTogglePresentation}
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

/** Button that patches reader preferences through the real provider state. */
function PreferenceProbe({ label, patch }: { label: string; patch: Partial<ReaderPreferences> }) {
  const { setPreferences } = useReader();
  return (
    <button type="button" onClick={() => setPreferences(patch)}>
      {label}
    </button>
  );
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
  it("opens the document through the range-backed engine seam and renders page one at 100%", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();

    // The open path is range-backed: the book id and format go straight to
    // the engine; no whole-file byte fetch happens on the critical path.
    expect(openDocumentMock).toHaveBeenCalledTimes(1);
    expect(openDocumentMock).toHaveBeenCalledWith(7, "pdf");
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
      get_reading_progress: null,
      save_reading_progress: null,
    });

    const onDocumentLoad = vi.fn();
    await renderLoadedReader({ onDocumentLoad });

    expect(onDocumentLoad).toHaveBeenCalledWith(3);
  });

  it("treats the pages per the reader theme (issue #67 color modes)", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    // Default (neutral) renders the pages as-is; Dark rasterizes with
    // worker-side Smart Dark recoloring (no CSS filter); Invert is the
    // explicit negative filter; Paper multiplies the tint over the pages.
    const onSearchGroup = vi.fn() as never;
    const onSelectionChange = vi.fn() as never;
    render(
      <ShortcutProvider>
        <ReaderProvider>
          <PreferenceProbe label="probe-dark" patch={{ theme: "dark" }} />
          <PreferenceProbe label="probe-invert" patch={{ theme: "invert" }} />
          <PreferenceProbe label="probe-paper" patch={{ theme: "paper" }} />
          <PdfReader
            book={pdfBook}
            onDocumentLoad={() => {}}
            onOutlineLoad={() => {}}
            onSearchGroup={onSearchGroup}
            onSearchDone={() => {}}
            onSelectionChange={onSelectionChange}
          />
        </ReaderProvider>
      </ShortcutProvider>,
    );
    await screen.findByTestId("pdf-canvas");
    expect(screen.getByTestId("pdf-document").style.filter).toBe("");

    // Smart dark: no filter — the recoloring happened at raster time.
    await userEvent.click(screen.getByRole("button", { name: "probe-dark" }));
    expect(screen.getByTestId("pdf-document").style.filter).toBe("");
    expect(screen.queryByTestId("pdf-theme-tint")).not.toBeInTheDocument();

    // The explicit negative: the full-page inversion filter.
    await userEvent.click(screen.getByRole("button", { name: "probe-invert" }));
    expect(screen.getByTestId("pdf-document").style.filter).toBe("invert(1) hue-rotate(180deg)");

    // Paper multiplies the white pages down to the theme's paper color.
    await userEvent.click(screen.getByRole("button", { name: "probe-paper" }));
    expect(screen.getByTestId("pdf-document").style.filter).toBe("");
    const tint = screen.getByTestId("pdf-theme-tint");
    expect(tint.style.backgroundColor).toBe("rgb(246, 240, 228)");
    expect(tint.style.mixBlendMode).toBe("multiply");
  });

  it("rasterizes with the Smart Dark palette when the dark theme is active (issue #67)", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    render(
      <ShortcutProvider>
        <ReaderProvider>
          <PreferenceProbe label="probe-dark" patch={{ theme: "dark" }} />
          <PreferenceProbe label="probe-default" patch={{ theme: "default" }} />
          <PdfReader book={pdfBook} onDocumentLoad={() => {}} onOutlineLoad={() => {}} />
        </ReaderProvider>
      </ShortcutProvider>,
    );
    await screen.findByTestId("pdf-canvas");
    await waitFor(() => expect(slot(1)).toHaveAttribute("data-render-state", "rendered"));

    // Neutral default: pages render as-is — no palette rides the requests.
    expect(doc.renderOptions.length).toBeGreaterThan(0);
    for (const call of doc.renderOptions) {
      expect(call.smartColors).toBeUndefined();
    }

    // Dark: every render request carries the Smart Dark palette (the EPUB
    // dark preset's own background/text pair), and switching re-renders.
    const before = doc.renderOptions.length;
    await userEvent.click(screen.getByRole("button", { name: "probe-dark" }));
    await waitFor(() => expect(doc.renderOptions.length).toBeGreaterThan(before));
    const smart = doc.renderOptions.at(-1)?.smartColors as
      { background: number[]; text: number[] } | undefined;
    expect(smart).toBeDefined();
    // #101013 background, #e4e4e7 text (0–1 components).
    expect(smart?.background[0]).toBeCloseTo(16 / 255, 3);
    expect(smart?.text[0]).toBeCloseTo(228 / 255, 3);

    // Back to default: the palette disappears again (variant invalidation
    // re-rendered — the smart colors are gone from the latest requests).
    const afterSmart = doc.renderOptions.length;
    await userEvent.click(screen.getByRole("button", { name: "probe-default" }));
    await waitFor(() => expect(doc.renderOptions.length).toBeGreaterThan(afterSmart));
    expect(doc.renderOptions.at(-1)?.smartColors).toBeUndefined();
  });

  it("placeholders pending page slots with the dark palette in Smart Dark (issue #67)", async () => {
    // A page that is queued/rendering shows the wrapper behind its still-
    // transparent canvas; white there is a white flash on a dark surface.
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    render(
      <ShortcutProvider>
        <ReaderProvider>
          <PreferenceProbe label="probe-dark" patch={{ theme: "dark" }} />
          <PreferenceProbe label="probe-default" patch={{ theme: "default" }} />
          <PdfReader book={pdfBook} onDocumentLoad={() => {}} onOutlineLoad={() => {}} />
        </ReaderProvider>
      </ShortcutProvider>,
    );
    await screen.findByTestId("pdf-canvas");
    await waitFor(() => expect(slot(1)).toHaveAttribute("data-render-state", "rendered"));

    // Default (neutral): the faithful paper-white placeholder.
    const wrapper = document.querySelector("[data-pdf-page-wrapper='1']");
    expect(wrapper).not.toBeNull();
    expect((wrapper as HTMLElement).style.backgroundColor).toBe("");

    // Smart Dark: the placeholder is the raster's own pre-fill color.
    await userEvent.click(screen.getByRole("button", { name: "probe-dark" }));
    await waitFor(() => {
      const darkWrapper = document.querySelector("[data-pdf-page-wrapper='1']");
      expect((darkWrapper as HTMLElement | null)?.style.backgroundColor).toBe("rgb(16, 16, 19)");
    });

    // Back to Default: the dark placeholder must go with it — a pending
    // slot returns to the paper-white background.
    await userEvent.click(screen.getByRole("button", { name: "probe-default" }));
    await waitFor(() => {
      const plainWrapper = document.querySelector("[data-pdf-page-wrapper='1']");
      expect((plainWrapper as HTMLElement | null)?.style.backgroundColor).toBe("");
    });
  });

  it("shows an honest error when the document cannot be opened", async () => {
    openDocumentMock.mockRejectedValueOnce(new Error("file went away"));

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
      get_reading_progress: null,
      save_reading_progress: null,
    });

    const view = await renderLoadedReader();
    view.unmount();

    expect(closeDocumentMock).toHaveBeenCalledWith(doc);
  });

  it("re-opens the document on unexpected worker failure", async () => {
    const doc = makeFakePdfDocument(3);
    const recovered = makeFakePdfDocument(3);
    openDocumentMock
      .mockResolvedValueOnce(doc as unknown as EngineDocument)
      .mockResolvedValueOnce(recovered as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    expect(openDocumentMock).toHaveBeenCalledTimes(1);

    // The worker dies underneath a loaded reader: the dead handle is
    // destroyed and the document re-opens from its range-backed source.
    doc.failWorker();
    await waitFor(() => expect(closeDocumentMock).toHaveBeenCalledWith(doc));
    await waitFor(() => expect(openDocumentMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(slot(1)).toHaveAttribute("data-render-state", "rendered"));
  });

  it("gives up after a second worker failure instead of looping", async () => {
    const first = makeFakePdfDocument(3);
    const second = makeFakePdfDocument(3);
    openDocumentMock
      .mockResolvedValueOnce(first as unknown as EngineDocument)
      .mockResolvedValueOnce(second as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();

    first.failWorker();
    await waitFor(() => expect(openDocumentMock).toHaveBeenCalledTimes(2));
    second.failWorker();
    expect(await screen.findByTestId("pdf-error")).toHaveTextContent(
      "PDF worker failed and could not be recovered",
    );
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
      get_reading_progress: null,
      save_reading_progress: null,
    });

    const view = await renderLoadedReader();
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3");

    view.rerenderBook({ book: secondBook });

    // The previous document is destroyed the moment the book changes, and
    // its reading surface leaves instead of lingering while the next loads.
    // Assert the loading surface synchronously: the mocked open resolves on
    // a microtask, and awaiting findBy first lets it swap loading out for
    // the next canvas, detaching the node before the membership check runs.
    expect(closeDocumentMock).toHaveBeenCalledWith(docA);
    expect(screen.getByTestId("pdf-loading")).toBeInTheDocument();
    await screen.findByTestId("pdf-canvas");
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 5");
    expect(openDocumentMock).toHaveBeenNthCalledWith(2, 8, "pdf");
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
      get_reading_progress: null,
      save_reading_progress: null,
    });

    const onOutlineLoad = vi.fn();
    await renderLoadedReader({ onOutlineLoad });

    // The outline request waits for the first rendered page (§ first-page
    // priority), so it can land a beat after the canvas mounts.
    await waitFor(() =>
      expect(getPdfOutline).toHaveBeenCalledWith(expect.objectContaining({ numPages: 3 })),
    );
    await waitFor(() => expect(onOutlineLoad).toHaveBeenCalledWith(outline));
  });

  it("never requests the outline ahead of the first rendered page", async () => {
    const onOutlineLoad = vi.fn();
    let resolveDocument: (value: EngineDocument) => void = () => {};
    openDocumentMock.mockReturnValue(
      new Promise((resolve) => {
        resolveDocument = resolve as (value: EngineDocument) => void;
      }) as never,
    );
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    renderPdfReader({ onOutlineLoad });
    await screen.findByTestId("pdf-loading");

    // § first-page priority: outline work must not occupy the PDFium worker
    // before page 1 has rendered.
    expect(getPdfOutline).not.toHaveBeenCalled();

    resolveDocument(makeFakePdfDocument(3) as unknown as EngineDocument);
    await screen.findByTestId("pdf-canvas");
    await waitFor(() => expect(getPdfOutline).toHaveBeenCalled());
  });

  it("publishes the PDF-open timeline attributes", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    renderPdfReader();
    // While the document is still opening the state names that stage.
    expect(screen.getByTestId("pdf-reader")).toHaveAttribute(
      "data-pdf-open-state",
      "document-opening",
    );

    await screen.findByTestId("pdf-canvas");
    await waitFor(() =>
      expect(screen.getByTestId("pdf-reader")).toHaveAttribute(
        "data-pdf-open-state",
        "interactive",
      ),
    );
    const root = screen.getByTestId("pdf-reader");
    expect(root).toHaveAttribute("data-pdf-open-state", "interactive");
    expect(root.getAttribute("data-pdf-open-timing")).toMatch(
      /^bytes=range;open=\d+;firstPaint=\d+;interactive=\d+$/,
    );
    expect(root.getAttribute("data-pdf-open-ms")).toMatch(/^\d+$/);
    expect(root.getAttribute("data-pdf-first-paint-ms")).toMatch(/^\d+$/);
    expect(root).toHaveAttribute("data-pdf-first-page", "1");
  });

  it("degrades outline failures to an empty outline", async () => {
    vi.mocked(getPdfOutline).mockRejectedValueOnce(new Error("outline boom"));
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    mockInvoke({
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

  it("byte-budgets active canvases when slots are 4K-sized (PERF-4)", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(100) as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    // Emulate the 4K reference conditions (docs/PERFORMANCE.md): a ~3816px
    // content area reserves the 24px Papers margin and fits the letter page
    // at ~6.2×, so each slot's capped buffer is ~75 MB and only ~3 fit the
    // 256 MB live-canvas budget.
    const area = screen.getByTestId("pdf-content-area");
    Object.defineProperty(area, "clientWidth", { value: 3816, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", "3792"));

    for (let page = 2; page <= 8; page++) {
      fireVisible(slot(page) as Element, true);
    }

    // The count fallback would allow 8; the byte budget keeps the closest 3
    // (anchor first) and the rest stay geometry-only slots.
    await waitFor(() => expect(canvasPages()).toEqual(["1", "2", "3"]));
    expect(slot(8)).toHaveAttribute("data-render-state", "unloaded");
  });

  it("blits a cached bitmap on window re-entry instead of re-rendering", async () => {
    const doc = makeFakePdfDocument(100);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
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
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();

    // A 1248px-wide content area reserves the Papers margin (2 * 12px) on
    // each side, so the 612pt reference page fits at 2×.
    const area = screen.getByTestId("pdf-content-area");
    Object.defineProperty(area, "clientWidth", { value: 1248, configurable: true });
    window.dispatchEvent(new Event("resize"));

    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", "1224"));
    expect(slot(1)).toHaveStyle({ width: "1224px" });
    // The zoom indicator shows the effective page zoom (scale × 100), not a
    // multiplier: the fit-width scale here is 2× the page's point size.
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("200");
  });

  it("fits against the document's largest page, not page 1", async () => {
    const doc = makeFakePdfDocument(3, (pageNumber) =>
      pageNumber === 2 ? { width: 1224, height: 612 } : { width: 612, height: 792 },
    );
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    const area = screen.getByTestId("pdf-content-area");
    Object.defineProperty(area, "clientWidth", { value: 1248, configurable: true });
    window.dispatchEvent(new Event("resize"));

    // Page 1 alone is the reference until the widest page is measured, so the
    // fit lands at (1248 - 24) / 612 = 2×.
    await waitFor(() => expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("200"));

    // Measuring the 1224pt-wide page raises the fit reference
    // (pps_document_get_max_page_size) to its width. The scale drops to
    // (1248 - 24) / 1224 = 1, so page 1 renders at its native width instead
    // of being blown up.
    firePreload(slot(2) as Element, true);
    await waitFor(() => expect(slot(1)).toHaveStyle({ width: "612px" }));
    expect(slot(2)).toHaveStyle({ width: "1224px" });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("100");
  });

  it("recomputes the fit scale when the window resizes", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    const area = screen.getByTestId("pdf-content-area");
    Object.defineProperty(area, "clientWidth", { value: 1248, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", "1224"));

    Object.defineProperty(area, "clientWidth", { value: 942, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", "918"));
  });

  it("holds the viewport center across toolbar zoom changes", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });
    const container = document.createElement("div");
    const view = renderPdfReader({ scrollContainerRef: { current: container } });
    await screen.findByTestId("pdf-canvas");
    stubScrollGeometry(container, screen.getByTestId("pdf-document"));
    const slotsAt = (scale: number) =>
      layoutSlots(
        displayedSizes(
          Array.from({ length: 3 }, (_, index) => ({
            pageNumber: index + 1,
            width: 612,
            height: 792,
          })),
          scale,
        ),
      );

    scrollTo(container, 900);
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );

    // Papers' toolbar and keyboard zoom uses the -1 sentinel, the viewport
    // center: the document point at `scrollTop + viewport/2` keeps its
    // fraction of the content through the scale change. Two steps on the
    // preset ladder go 100 -> 125 -> 150.
    const viewport = container.clientHeight;
    const centerDoc = 900 + viewport / 2;
    const expected =
      (centerDoc / documentHeight(slotsAt(1))) * documentHeight(slotsAt(1.5)) - viewport / 2;

    await userEvent.click(screen.getByTestId("pdf-zoom-in"));
    await userEvent.click(screen.getByTestId("pdf-zoom-in"));
    await waitFor(() => expect(container.scrollTop).toBeCloseTo(expected, 3));
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("150");
    view.unmount();
  });

  it("zooms from the keyboard with + and -", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    fireEvent.keyDown(window, { key: "+" });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("125");
    fireEvent.keyDown(window, { key: "-" });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("100");
    fireEvent.keyDown(window, { key: "-" });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("75");
  });
});

describe("PdfReader hardening", () => {
  it("shows a retryable page-level error without breaking the document", async () => {
    const doc = makeFakePdfDocument(3, undefined, { failOnceFor: [2] });
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
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
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    for (let i = 0; i < 12; i++) fireEvent.keyDown(window, { key: "-" });
    // The preset ladder floor is 12% (Okular's kZoomValues[0]).
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("12");
    expect(screen.getByTestId("pdf-zoom-out")).toBeDisabled();

    for (let i = 0; i < 20; i++) fireEvent.keyDown(window, { key: "+" });
    // The preset ladder ceiling is 10000% (Okular's tiled cap).
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("10000");
    expect(screen.getByTestId("pdf-zoom-in")).toBeDisabled();
  });
});

describe("PdfReader navigation", () => {
  it("navigates with prev/next and disables at both bounds", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
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

describe("PdfReader controls docking", () => {
  async function renderWithHeaderHost() {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    // Mirrors the shell: a header-owned slot the reader's controls portal
    // into (issue #68), rendered alongside the reader itself.
    function Harness() {
      const [host, setHost] = useState<HTMLElement | null>(null);
      return (
        <div>
          <header ref={setHost} data-testid="fake-reader-header" />
          {readerTree({ controlsHost: host })}
        </div>
      );
    }

    render(<Harness />);
    await screen.findByTestId("pdf-canvas");
  }

  it("docks the toolbar into the shell's header host when one is provided", async () => {
    await renderWithHeaderHost();

    // The controls live in the header, not in a separate row above the
    // document — the reader element must not contain them.
    const toolbar = screen.getByTestId("pdf-toolbar");
    expect(screen.getByTestId("fake-reader-header")).toContainElement(toolbar);
    expect(screen.getByTestId("pdf-reader")).not.toContainElement(toolbar);
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3");
  });

  it("keeps navigation working through the docked controls", async () => {
    await renderWithHeaderHost();

    await userEvent.click(screen.getByTestId("pdf-next"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );
    expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "2");
  });
});

describe("PdfReader zoom", () => {
  it("re-anchors the active page slot when the zoom changes", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
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
    // A superseding render coalesces a short quiet period before it starts.
    await waitFor(() => expect(pending).toHaveLength(1));
    const [freshRender] = pending.splice(0) as [(page: unknown) => void];

    // The NEWER render resolves first and paints at 125%…
    freshRender(gatedPage);
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", String(612 * 1.25)),
    );
    expect(gatedPage.render).toHaveBeenCalledTimes(1);

    // …then the STALE one resolves. It must not cancel the fresh render or
    // paint old-scale content over the resized canvas (real-world symptom:
    // mirrored page fragments blitted over pages while scrolling).
    staleRender(gatedPage);
    await waitFor(() => expect(gatedPage.render).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", String(612 * 1.25));
  });

  it("steps through the zoom presets and re-renders the viewport", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("100");
    expect(screen.getByTestId("pdf-zoom-out")).toBeEnabled();

    await userEvent.click(screen.getByTestId("pdf-zoom-in"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", String(612 * 1.25)),
    );
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("125");
    expect(doc.scales).toContain(1.25);

    await userEvent.click(screen.getByTestId("pdf-zoom-in"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", String(612 * 1.5)),
    );
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("150");
    // Zoom rescales the whole document layout, not just the canvas.
    expect(slot(1)).toHaveStyle({ width: "918px" });
    expect(slot(3)).toHaveStyle({ height: "1188px" });

    // Stepping back down walks the same presets.
    await userEvent.click(screen.getByTestId("pdf-zoom-out"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", String(612 * 1.25)),
    );
    await userEvent.click(screen.getByTestId("pdf-zoom-out"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", String(612)),
    );
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("100");
  });
});

describe("PdfReader in-book search", () => {
  it("streams per-page match groups and reports completion", async () => {
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });
    const doc = makeFakePdfDocument(2);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    vi.mocked(getPdfPageText).mockImplementation(async (_document, page) =>
      page === 1 ? "alpha beta gamma" : "delta beta epsilon",
    );

    const adapterRef: { current: ReaderAdapter | null } = { current: null };
    const groups: Array<{ label: string; matches: unknown[] }> = [];
    let done = false;
    renderPdfReader({
      adapterRef,
      onSearchGroup: (_bookId, group) => groups.push(group as never),
      onSearchDone: () => {
        done = true;
      },
    });
    await screen.findByTestId("pdf-canvas");

    adapterRef.current!.search.run("beta");
    await waitFor(() => expect(groups).toHaveLength(2));
    expect(groups[0]).toEqual({
      label: "Page 1",
      matches: [
        { locator: null, page: 1, excerpt: { pre: "alpha ", match: "beta", post: " gamma" } },
      ],
    });
    expect(groups[1]?.label).toBe("Page 2");
    await waitFor(() => expect(done).toBe(true));
  });

  it("drops the page-text cache when the document changes", async () => {
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });
    const first = makeFakePdfDocument(1);
    const second = makeFakePdfDocument(1);
    openDocumentMock.mockResolvedValueOnce(first as unknown as EngineDocument);
    openDocumentMock.mockResolvedValueOnce(second as unknown as EngineDocument);
    vi.mocked(getPdfPageText).mockImplementation(async (_document, page) => `text ${page}`);

    const adapterRef: { current: ReaderAdapter | null } = { current: null };
    const { rerenderBook } = renderPdfReader({ adapterRef, book: pdfBook });
    await screen.findByTestId("pdf-canvas");
    adapterRef.current!.search.run("text");
    await waitFor(() => expect(vi.mocked(getPdfPageText)).toHaveBeenCalled());

    rerenderBook({ adapterRef, book: { ...pdfBook, id: 8 } });
    await screen.findAllByTestId("pdf-canvas");
    adapterRef.current!.search.run("text");
    await waitFor(() =>
      expect(vi.mocked(getPdfPageText)).toHaveBeenCalledWith(
        second as unknown as EngineDocument,
        1,
      ),
    );
  });
});

describe("PdfReader text layer and highlights", () => {
  function mockLoadedDocument(): void {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });
  }

  it("mounts a text layer for every rendered page", async () => {
    mockLoadedDocument();
    renderPdfReader();
    await screen.findByTestId("pdf-canvas");
    fireVisible(slot(1) as Element, true);

    await waitFor(() => expect(slot(1)).toHaveAttribute("data-render-state", "rendered"));
    const layer = document.querySelector('[data-pdf-text-layer="1"]');
    expect(layer).not.toBeNull();
    expect(vi.mocked(renderPdfTextLayer)).toHaveBeenCalledWith(
      expect.anything(),
      1,
      layer,
      expect.any(Number),
    );
  });

  it("draws persisted highlights over the rendered page", async () => {
    mockLoadedDocument();
    renderPdfReader({
      highlights: [
        makeAnnotation({
          id: 11,
          pageNumber: 1,
          color: "blue",
          rects: [
            { x: 0.1, y: 0.2, width: 0.5, height: 0.02 },
            { x: 0.1, y: 0.25, width: 0.3, height: 0.02 },
          ],
        }),
      ],
    });
    await screen.findByTestId("pdf-canvas");
    fireVisible(slot(1) as Element, true);
    await waitFor(() => expect(slot(1)).toHaveAttribute("data-render-state", "rendered"));

    const drawn = document.querySelectorAll('[data-pdf-highlight="11"]');
    expect(drawn).toHaveLength(2);
  });

  it("creates a highlight from the live selection with normalized rects", async () => {
    mockLoadedDocument();
    const onCreateHighlight = vi.fn();
    const onSelectionChange = vi.fn();
    const adapterRef: { current: ReaderAdapter | null } = { current: null };
    renderPdfReader({ onCreateHighlight, onSelectionChange, adapterRef });
    await screen.findByTestId("pdf-canvas");

    // A selection anchored inside page 1's slot with two client rects (one
    // zero-sized, which must be dropped).
    const pageSlot = slot(1) as HTMLElement;
    const anchor = document.createElement("span");
    pageSlot.appendChild(anchor);
    pageSlot.getBoundingClientRect = () => new DOMRect(0, 0, 512, 512);
    const fakeRange = {
      getClientRects: () => [new DOMRect(64, 64, 128, 32), new DOMRect(0, 0, 0, 0)],
    };
    const fakeSelection = {
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: anchor,
      toString: () => "selected words",
      getRangeAt: () => fakeRange,
      removeAllRanges: vi.fn(),
    };
    const selectionSpy = vi
      .spyOn(window, "getSelection")
      .mockReturnValue(fakeSelection as unknown as Selection);

    // The selection is captured on pointerup (deferred one tick).
    fireEvent.pointerUp(document);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      text: "selected words",
      highlightId: null,
    });

    adapterRef.current!.annotations.createHighlight("green");
    expect(onCreateHighlight).toHaveBeenCalledWith({
      kind: "highlight",
      pageNumber: 1,
      rects: [{ x: 0.125, y: 0.125, width: 0.25, height: 0.0625 }],
      text: "selected words",
      color: "green",
    });
    expect(fakeSelection.removeAllRanges).toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
    selectionSpy.mockRestore();
  });

  it("reports an existing highlight the selection overlaps", async () => {
    mockLoadedDocument();
    const onSelectionChange = vi.fn();
    renderPdfReader({
      onSelectionChange,
      highlights: [
        makeAnnotation({
          id: 11,
          pageNumber: 1,
          color: "yellow",
          rects: [{ x: 0.1, y: 0.1, width: 0.4, height: 0.2 }],
        }),
      ],
    });
    await screen.findByTestId("pdf-canvas");

    const pageSlot = slot(1) as HTMLElement;
    const anchor = document.createElement("span");
    pageSlot.appendChild(anchor);
    pageSlot.getBoundingClientRect = () => new DOMRect(0, 0, 512, 512);
    const fakeSelection = {
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: anchor,
      toString: () => "selected words",
      getRangeAt: () => ({ getClientRects: () => [new DOMRect(64, 64, 128, 32)] }),
    };
    const selectionSpy = vi
      .spyOn(window, "getSelection")
      .mockReturnValue(fakeSelection as unknown as Selection);

    fireEvent.pointerUp(document);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The selection rects (normalized 0.125..0.375) intersect the stored
    // highlight, so the toolbar edits it instead of stacking a new one.
    expect(onSelectionChange).toHaveBeenLastCalledWith({ text: "selected words", highlightId: 11 });
    selectionSpy.mockRestore();
  });

  it("reports a clicked highlight and misses outside every highlight", async () => {
    mockLoadedDocument();
    const onSelectionChange = vi.fn();
    renderPdfReader({
      onSelectionChange,
      highlights: [
        makeAnnotation({
          id: 11,
          pageNumber: 1,
          color: "blue",
          text: "the stored words",
          rects: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
        }),
      ],
    });
    await screen.findByTestId("pdf-canvas");

    const pageSlot = slot(1) as HTMLElement;
    const anchor = document.createElement("span");
    pageSlot.appendChild(anchor);
    pageSlot.getBoundingClientRect = () => new DOMRect(0, 0, 512, 512);
    const collapsed = {
      isCollapsed: true,
      rangeCount: 1,
      anchorNode: anchor,
      toString: () => "",
    };
    const selectionSpy = vi
      .spyOn(window, "getSelection")
      .mockReturnValue(collapsed as unknown as Selection);

    // A plain click inside the highlight's rect addresses it: the toolbar
    // can then recolor or remove the annotation.
    fireEvent.pointerUp(anchor, { clientX: 64, clientY: 64 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      text: "the stored words",
      highlightId: 11,
    });

    onSelectionChange.mockClear();
    fireEvent.pointerUp(anchor, { clientX: 480, clientY: 480 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
    selectionSpy.mockRestore();
  });
});

describe("PdfReader zoom modes (issue #65)", () => {
  async function renderZoomableReader(container: HTMLElement) {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });
    const view = renderPdfReader({ scrollContainerRef: { current: container } });
    await screen.findByTestId("pdf-canvas");
    return { doc, view };
  }

  /** Real ~WHEEL_SETTLE_MS wait so the trailing commit timer fires. */
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

  /** Canvas width within a pixel (canvases floor to whole device pixels). */
  const expectCanvasWidthNear = (expected: number) =>
    expect(
      Math.abs(Number(screen.getByTestId("pdf-canvas").getAttribute("width")) - expected),
    ).toBeLessThan(1);

  it("resets to 100% with Ctrl+0 after manual zooming", async () => {
    await renderZoomableReader(document.createElement("div"));
    fireEvent.keyDown(window, { key: "+" });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("125");

    fireEvent.keyDown(window, { key: "0", ctrlKey: true });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("100");
  });

  it("switches into the fit modes with Ctrl+1/2/3", async () => {
    await renderZoomableReader(document.createElement("div"));
    const toolbar = screen.getByTestId("pdf-toolbar");

    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    expect(toolbar).toHaveAttribute("data-pdf-zoom-mode", "fit-page");
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    expect(toolbar).toHaveAttribute("data-pdf-zoom-mode", "fit-width");
    fireEvent.keyDown(window, { key: "3", ctrlKey: true });
    expect(toolbar).toHaveAttribute("data-pdf-zoom-mode", "fit-auto");
  });

  it("applies a preset and a fit mode from the zoom dropdown", async () => {
    await renderZoomableReader(document.createElement("div"));
    const toolbar = screen.getByTestId("pdf-toolbar");

    await userEvent.click(screen.getByTestId("pdf-zoom-menu"));
    await userEvent.click(await screen.findByTestId("pdf-zoom-preset-200"));
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("200");
    expect(toolbar).toHaveAttribute("data-pdf-zoom-mode", "custom");

    await userEvent.click(screen.getByTestId("pdf-zoom-menu"));
    await userEvent.click(await screen.findByTestId("pdf-zoom-fit-auto"));
    expect(toolbar).toHaveAttribute("data-pdf-zoom-mode", "fit-auto");
  });

  it("applies a typed percentage, clamps it, and reverts invalid input", async () => {
    await renderZoomableReader(document.createElement("div"));
    const input = screen.getByTestId("pdf-zoom-input");

    await userEvent.clear(input);
    await userEvent.type(input, "137{Enter}");
    expect(input).toHaveValue("137");
    expect(screen.getByTestId("pdf-toolbar")).toHaveAttribute("data-pdf-zoom-mode", "custom");

    // Above the cap: clamped to 10000%.
    await userEvent.clear(input);
    await userEvent.type(input, "99999{Enter}");
    expect(input).toHaveValue("10000");

    // Unparseable: the current value is kept.
    await userEvent.clear(input);
    await userEvent.type(input, "abc{Enter}");
    expect(input).toHaveValue("10000");
  });

  it("switches to a viewport-clipped region above the whole-page budget", async () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 792, configurable: true });
    Object.defineProperty(container, "clientWidth", { value: 1224, configurable: true });
    await renderZoomableReader(container);
    const area = screen.getByTestId("pdf-content-area");
    Object.defineProperty(area, "clientWidth", { value: 1224, configurable: true });
    window.dispatchEvent(new Event("resize"));

    // Fit width keeps the whole-page path.
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-render-region", "full"),
    );

    const input = screen.getByTestId("pdf-zoom-input");
    await userEvent.clear(input);
    await userEvent.type(input, "1600{Enter}");

    await waitFor(() => {
      const canvas = screen.getByTestId("pdf-canvas");
      const region = canvas.getAttribute("data-pdf-render-region") ?? "";
      expect(region).toMatch(/^\d+,\d+,\d+,\d+$/);
      const [x, y, w] = region.split(",").map(Number);
      expect(canvas).toHaveStyle({ left: `${x}px`, top: `${y}px`, width: `${w}px` });
    });
  });

  it("steps the presets with the Ctrl-modified zoom keys", async () => {
    await renderZoomableReader(document.createElement("div"));
    fireEvent.keyDown(window, { key: "+", ctrlKey: true });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("125");
    fireEvent.keyDown(window, { key: "=", ctrlKey: true });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("150");
    fireEvent.keyDown(window, { key: "-", ctrlKey: true });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("125");
  });

  it("zooms continuously with Ctrl + wheel: live preview, sharp redraw after the wheel settles", async () => {
    const container = document.createElement("div");
    const { doc } = await renderZoomableReader(container);

    // One notch previews ×1.2 immediately in the toolbar — no preset snap.
    fireEvent.wheel(container, { deltaY: -100, ctrlKey: true, clientX: 300, clientY: 300 });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("120");

    // The gesture is a CSS transform about the cursor; nothing re-renders.
    const documentEl = screen.getByTestId("pdf-document");
    expect(documentEl).toHaveStyle({ transform: "scale(1.2)", transformOrigin: "300px 300px" });
    expect(doc.scales).not.toContain(1.2);
    expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", "612");

    // Trackpad deltas keep multiplying the preview continuously.
    fireEvent.wheel(container, { deltaY: -30, ctrlKey: true, clientX: 300, clientY: 300 });
    expect(Number((screen.getByTestId("pdf-zoom-input") as HTMLInputElement).value)).toBeCloseTo(
      100 * 1.2 ** 1.3,
      1,
    );

    // 250ms after the last event the scale commits and the page rasterizes
    // sharp at the previewed scale; the preview transform is gone.
    await settle();
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("126.7");
    await waitFor(() => expectCanvasWidthNear(612 * 1.2 ** 1.3));
    expect(doc.scales.some((scale) => Math.abs(scale - 1.2 ** 1.3) < 1e-9)).toBe(true);
    expect(documentEl.style.transform).toBe("");

    // The committed zoom is the base for the keyboard presets (closest next).
    fireEvent.keyDown(window, { key: "-" });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("125");

    // Plain wheel events still scroll; they never zoom.
    fireEvent.wheel(container, { deltaY: -120 });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("125");
  });

  it("caps one wheel event at three notches and clamps to the zoom bounds", async () => {
    const container = document.createElement("div");
    await renderZoomableReader(container);

    // A huge single event moves at most 300px of delta: 1.2³.
    fireEvent.wheel(container, { deltaY: -50_000, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("172.8");
    await settle();

    // At the 10000% ceiling the wheel cannot push further.
    const input = screen.getByTestId("pdf-zoom-input");
    await userEvent.clear(input);
    await userEvent.type(input, "99999{Enter}");
    expect(input).toHaveValue("10000");
    fireEvent.wheel(container, { deltaY: -500, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(input).toHaveValue("10000");
    await settle();
    expect(input).toHaveValue("10000");
  });

  it("multiplies the derived fit scale on the first wheel tick out of a fit mode", async () => {
    const container = document.createElement("div");
    const { doc } = await renderZoomableReader(container);

    // 1248px content area reserves the 24px Papers margin, fitting the 612pt
    // reference page at 2× (200%).
    const area = screen.getByTestId("pdf-content-area");
    Object.defineProperty(area, "clientWidth", { value: 1248, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("200"));

    fireEvent.wheel(container, { deltaY: -100, ctrlKey: true, clientX: 10, clientY: 10 });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("240");
    await settle();
    expect(screen.getByTestId("pdf-toolbar")).toHaveAttribute("data-pdf-zoom-mode", "custom");
    await waitFor(() => expectCanvasWidthNear(612 * 2.4));
    expect(doc.scales).toContain(2.4);
  });

  it("flushes a pending wheel gesture immediately when another zoom action runs", async () => {
    const container = document.createElement("div");
    const { doc } = await renderZoomableReader(container);

    // Two ticks preview 144%; the toolbar "+" steps from that preview base.
    fireEvent.wheel(container, { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
    fireEvent.wheel(container, { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("144");

    fireEvent.keyDown(window, { key: "+" });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("150");
    await waitFor(() => expectCanvasWidthNear(612 * 1.5));
    expect(screen.getByTestId("pdf-document").style.transform).toBe("");

    // The abandoned settle timer must not fire a second commit afterwards.
    const scalesBefore = doc.scales.length;
    await settle();
    expect(doc.scales.length).toBe(scalesBefore);
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("150");
  });

  it("keeps the point under the cursor through a wheel zoom that crosses the viewport extent", async () => {
    const container = document.createElement("div");
    await renderZoomableReader(container);
    stubScrollGeometry(container, screen.getByTestId("pdf-document"));
    // Wider than the page at 100%: the content extent starts below the
    // viewport on X and rises past it across the zoom. The old
    // MAX(viewport, content) denominator changed meaning there, so the cursor
    // point drifted (north-west on zoom in, south-east on zoom out).
    Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 800, configurable: true });
    scrollTo(container, 0);

    const cursorX = 200;
    const cursorY = 200;
    // The capped step (-300) takes the page from narrower than the viewport to
    // wider, so the vertical axis becomes scrollable during the zoom.
    fireEvent.wheel(container, { deltaY: -300, ctrlKey: true, clientX: cursorX, clientY: cursorY });
    await settle();

    const newScale = Number((screen.getByTestId("pdf-zoom-input") as HTMLInputElement).value) / 100;
    expect(newScale).toBeGreaterThan(1.7);
    // The page point under the cursor, in page units, is unchanged on both
    // axes. Nothing here mirrors the implementation formula: this is the
    // property the reader must hold.
    // Within a CSS pixel: the slot heights and the reported zoom are rounded,
    // so the held point lands on the nearest pixel, not exactly.
    expect(Math.abs((container.scrollLeft + cursorX) / newScale - cursorX)).toBeLessThan(1);
    expect(Math.abs((container.scrollTop + cursorY) / newScale - cursorY)).toBeLessThan(1);
    expect(screen.getByTestId("pdf-reader")).toHaveAttribute("data-pdf-scroll-policy", "center");
  });

  it("holds the viewport center on a keyboard zoom", async () => {
    const doc = makeFakePdfDocument(1, () => ({ width: 612, height: 2000 }));
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({ get_reading_progress: null, save_reading_progress: null });
    const container = document.createElement("div");
    renderPdfReader({ scrollContainerRef: { current: container } });
    await screen.findByTestId("pdf-canvas");
    stubScrollGeometry(container, screen.getByTestId("pdf-document"));
    Object.defineProperty(container, "clientHeight", { value: 800, configurable: true });
    Object.defineProperty(container, "scrollHeight", { value: 5000, configurable: true });
    Object.defineProperty(container, "scrollWidth", { value: 1000, configurable: true });
    scrollTo(container, 500);

    fireEvent.keyDown(window, { key: "+" });
    await settle();

    // Papers' -1 sentinel: the keyboard step holds the viewport center. Scale
    // 1 -> 1.25, content 2000 -> 2500, so (500 + 400) / 2000 = (new + 400) / 2500.
    expect(container.scrollTop).toBeCloseTo(725, 4);
    expect(screen.getByTestId("pdf-reader")).toHaveAttribute("data-pdf-scroll-policy", "center");
  });

  it("keeps the relative position on a typed zoom", async () => {
    const doc = makeFakePdfDocument(1, () => ({ width: 612, height: 2000 }));
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({ get_reading_progress: null, save_reading_progress: null });
    const container = document.createElement("div");
    renderPdfReader({ scrollContainerRef: { current: container } });
    await screen.findByTestId("pdf-canvas");
    stubScrollGeometry(container, screen.getByTestId("pdf-document"));
    Object.defineProperty(container, "clientHeight", { value: 800, configurable: true });
    Object.defineProperty(container, "scrollHeight", { value: 6000, configurable: true });
    Object.defineProperty(container, "scrollWidth", { value: 1000, configurable: true });
    scrollTo(container, 500);

    const input = screen.getByTestId("pdf-zoom-input");
    await userEvent.clear(input);
    await userEvent.type(input, "200{Enter}");
    await settle();

    // Papers' KEEP_POSITION: 500 / 2000 = 0.25, new content 4000 -> 1000.
    expect(container.scrollTop).toBeCloseTo(1000, 4);
    expect(screen.getByTestId("pdf-reader")).toHaveAttribute(
      "data-pdf-scroll-policy",
      "keep-position",
    );
  });

  it("keeps every rendered canvas drawable through a zoom commit (scale-and-swap)", async () => {
    const doc = makeFakePdfDocument(3, undefined, { holdRenderFor: [1, 2, 3] });
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });
    const container = document.createElement("div");
    renderPdfReader({ scrollContainerRef: { current: container } });
    await screen.findByTestId("pdf-canvas");

    // Bring all three pages into the window and complete their first paints.
    doc.releaseRender(1);
    await waitFor(() => expect(slot(1)).toHaveAttribute("data-render-state", "rendered"));
    fireVisible(slot(2) as Element, true);
    await waitFor(() => expect(canvasPages()).toContain("2"));
    doc.releaseRender(2);
    await waitFor(() => expect(slot(2)).toHaveAttribute("data-render-state", "rendered"));
    fireVisible(slot(3) as Element, true);
    await waitFor(() => expect(canvasPages()).toContain("3"));
    doc.releaseRender(3);
    await waitFor(() => expect(slot(3)).toHaveAttribute("data-render-state", "rendered"));
    expect(canvasPages()).toEqual(["1", "2", "3"]);

    // A zoom keeps every previously rendered canvas mounted. Each presents
    // its previous bitmap scaled to the new page box while the new-scale
    // raster is held, so the commit never shows a blank frame. Asserting the
    // "scaled" quality (not final) is what proves the old bitmap is on
    // screen: the held render cannot have replaced it yet.
    await userEvent.click(screen.getByTestId("pdf-zoom-in"));
    await waitFor(() => {
      expect(canvasPages()).toEqual(["1", "2", "3"]);
      for (const canvas of screen.getAllByTestId("pdf-canvas")) {
        expect(canvas).toHaveAttribute("data-pdf-render-quality", "scaled");
      }
    });

    const canvasFor = (page: string) =>
      screen
        .getAllByTestId("pdf-canvas")
        .find((canvas) => canvas.getAttribute("data-pdf-page") === page);
    const page1 = canvasFor("1");
    const page2 = canvasFor("2");
    const page3 = canvasFor("3");

    // Only the pages inside the render budget get a new raster. Completing
    // them swaps the scaled bitmap for the sharp final one, atomically; the
    // page outside the budget keeps its scaled bitmap and starts no render.
    doc.releaseRender(1);
    doc.releaseRender(2);
    await waitFor(() => {
      expect(page1).toHaveAttribute("data-pdf-render-quality", "final");
      expect(page2).toHaveAttribute("data-pdf-render-quality", "final");
    });
    expect(page3).toHaveAttribute("data-pdf-render-quality", "scaled");
  });

  it("unmounts mid-gesture through the commit path without errors", async () => {
    const container = document.createElement("div");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { view } = await renderZoomableReader(container);
      fireEvent.wheel(container, { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
      expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("120");

      // Closing the reader before the settle timer must not throw, warn, or
      // leave the timer to fire against a dead tree.
      view.unmount();
      await settle();
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("PdfReader presentation mode (issue #65)", () => {
  /** Container one letter page high; the fit-page scale reserves the margin. */
  function stubViewportContainer(): HTMLElement {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 792, configurable: true });
    return container;
  }

  /** Content-area width the presentation fit-page scale measures against. */
  const PRESENT_AREA_WIDTH = 1224;

  async function renderPresentingReader(
    props: PdfReaderProps = {},
    book?: Book,
    areaWidth: number = PRESENT_AREA_WIDTH,
  ) {
    openDocumentMock.mockResolvedValue(
      makeFakePdfDocument(3, (pageNumber) =>
        pageNumber === 2 ? { width: 1224, height: 612 } : { width: 612, height: 792 },
      ) as unknown as EngineDocument,
    );
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });
    const container = stubViewportContainer();
    const view = renderPdfReader({
      scrollContainerRef: { current: container },
      presentationMode: true,
      ...props,
      book: book ?? pdfBook,
    });
    await screen.findByTestId("pdf-canvas");
    if (areaWidth > 0) {
      const area = screen.getByTestId("pdf-content-area");
      Object.defineProperty(area, "clientWidth", { value: areaWidth, configurable: true });
      window.dispatchEvent(new Event("resize"));
    }
    return view;
  }

  it("presents only the selected page, fit inside the area", async () => {
    await renderPresentingReader();

    expect(screen.getByTestId("pdf-reader")).toHaveAttribute("data-pdf-presentation", "true");
    // The single-page surface mounts just the current slot, so no neighbour
    // can show through the scroll container. The 792px viewport reserves the
    // 24px Papers margin, so the letter page fits at 0.9697× (height 768).
    expect(slot(1)).toHaveStyle({ height: "768px" });
    expect(slot(2)).toBeNull();
    expect(slot(3)).toBeNull();
  });

  it("fits a landscape page to the area width instead of overflowing", async () => {
    await renderPresentingReader();

    await userEvent.click(screen.getByTestId("pdf-pres-next"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );
    // The flipped-to page is now the only slot in the document.
    expect(slot(1)).toBeNull();
    expect(slot(3)).toBeNull();

    // Measure page 2 (landscape) as the visible observer would.
    fireVisible(slot(2) as Element, true);
    // The 1224pt-wide page is width-bound: the contain scale is
    // (1224 - 24) / 1224, so it fills the area minus the Papers margin
    // (1200x600) and never clips (a height-only fit would have made it
    // 1584px wide).
    await waitFor(() => expect(slot(2)).toHaveStyle({ width: "1200px", height: "600px" }));
  });

  it("keeps the current page on enter and restores the zoom state on exit", async () => {
    // No measured area width: the pre-presentation fit-width scale falls
    // back to 1× so the zoom step below lands on 150%.
    const view = await renderPresentingReader({ presentationMode: false }, undefined, 0);
    expect(screen.getByTestId("pdf-toolbar")).toBeInTheDocument();

    // Land on page 2 and zoom to 150% before entering (two preset steps).
    await userEvent.click(screen.getByTestId("pdf-next"));
    await userEvent.click(screen.getByTestId("pdf-zoom-in"));
    await userEvent.click(screen.getByTestId("pdf-zoom-in"));
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("150");

    view.rerenderBook({ presentationMode: true });
    expect(screen.getByTestId("pdf-reader")).toHaveAttribute("data-pdf-presentation", "true");
    // The header toolbar is gone; the floating bar carries the controls.
    expect(screen.queryByTestId("pdf-toolbar")).toBeNull();
    expect(screen.getByTestId("pdf-presentation-bar")).toBeInTheDocument();
    // Page is preserved. Page 2 is still the page-1 estimate in jsdom, so
    // the contained height is the 792px page less the Papers margin (768px).
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );
    expect(slot(2)).toHaveStyle({ height: "768px" });

    view.rerenderBook({ presentationMode: false });
    expect(screen.queryByTestId("pdf-presentation-bar")).toBeNull();
    expect(screen.getByTestId("pdf-toolbar")).toBeInTheDocument();
    // The pre-presentation zoom state is restored exactly.
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("150");
  });

  it("navigates and exits through the presentation bar", async () => {
    const onExitPresentation = vi.fn();
    await renderPresentingReader({ onExitPresentation });

    await userEvent.click(screen.getByTestId("pdf-pres-next"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );
    await userEvent.click(screen.getByTestId("pdf-pres-prev"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3"),
    );

    expect(onExitPresentation).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("pdf-pres-exit"));
    expect(onExitPresentation).toHaveBeenCalledTimes(1);
  });

  it("pre-renders the next page so a step blits instead of re-rastering", async () => {
    const doc = makeFakePdfDocument(3, (pageNumber) =>
      pageNumber === 2 ? { width: 1224, height: 612 } : { width: 612, height: 792 },
    );
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({ get_reading_progress: null, save_reading_progress: null });
    const container = stubViewportContainer();
    renderPdfReader({
      scrollContainerRef: { current: container },
      presentationMode: true,
      book: pdfBook,
    });
    await screen.findByTestId("pdf-canvas");
    const area = screen.getByTestId("pdf-content-area");
    Object.defineProperty(area, "clientWidth", { value: PRESENT_AREA_WIDTH, configurable: true });
    window.dispatchEvent(new Event("resize"));

    // Page 1 is on screen and page 2 is already rasterized offscreen (once),
    // so the shared cache holds the neighbour before any navigation.
    await waitFor(() => expect(doc.renderPages.filter((page) => page === 2)).toHaveLength(1));
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3");

    // Stepping forward consumes that bitmap: page 2 is never rastered a second
    // time, so the step cannot flash a blank placeholder while it renders.
    await userEvent.click(screen.getByTestId("pdf-pres-next"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );
    await screen.findByTestId("pdf-canvas");
    expect(doc.renderPages.filter((page) => page === 2)).toHaveLength(1);
  });
});
