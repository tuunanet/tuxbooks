import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
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
import { PdfToolbar } from "@/components/reader/pdf/PdfToolbar";
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
import { pageToPosition } from "@/components/reader/pdf/pdfPages";
import {
  clearPdfZoomLog,
  dumpPdfZoomLog,
  setPdfZoomTelemetryEnabled,
} from "@/lib/pdf/pdfZoomTelemetry";
import type { Annotation } from "@/types/domain";
import type { Book } from "@/types/domain";
import { scrollTo, stubScrollGeometry } from "./mocks/dom";
import { fireIntersection, intersectionObservers } from "./mocks/intersectionObserver";
import { invokeMock, mockInvoke } from "./mocks/bridge";
import { makeFakePdfDocument } from "./mocks/pdfEngine";
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
  /** Renders a preference probe (real provider state) as a sibling. */
  preferencesPatch?: Partial<ReaderPreferences>;
  /** Renders a raw-position probe (page in a 3-page document) as a sibling. */
  probePage?: number;
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
        {props.preferencesPatch ? (
          <PreferenceProbe label="probe-preferences" patch={props.preferencesPatch} />
        ) : null}
        {props.probePage !== undefined ? <PositionProbe page={props.probePage} /> : null}
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

/** Button that writes a raw reading position through the real provider state. */
function PositionProbe({ page }: { page: number }) {
  const { setPosition } = useReader();
  return (
    <button
      type="button"
      data-testid={`probe-position-${page}`}
      onClick={() => setPosition(pageToPosition(page, 3))}
    >
      probe-position-{page}
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
  it("opens the document and renders page one at 100%", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();

    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3");

    const canvas = await screen.findByTestId("pdf-canvas");
    await waitFor(() => expect(canvas).toHaveAttribute("width", "612"));
    expect(canvas).toHaveAttribute("height", "792");
    expect(canvas).toHaveAttribute("data-pdf-page", "1");
    await waitFor(() => expect(slot(1)).toHaveAttribute("data-render-state", "rendered"));
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

    firePreload(slot(2) as Element, true);
    await waitFor(() => expect(slot(2)).toHaveStyle({ width: "792px", height: "612px" }));
    expect(slot(1)).toHaveStyle({ width: "612px", height: "792px" });
    expect(slot(3)).toHaveStyle({ width: "612px", height: "792px" });
    expect(slot(2)?.style.marginTop).toBe("8px");
    expect(canvasPages()).toEqual(["1", "2"]);
  });

  it("estimates unmeasured pages from the sampled median, not an odd page 1", async () => {
    const doc = makeFakePdfDocument(20, (pageNumber) =>
      pageNumber === 1 ? { width: 827, height: 1180 } : { width: 504, height: 720 },
    );
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();

    await waitFor(() => expect(slot(1)).toHaveStyle({ width: "827px", height: "1180px" }));
    expect(slot(2)).toHaveStyle({ width: "504px", height: "720px" });
    expect(slot(12)).toHaveStyle({ width: "504px", height: "720px" });
  });

  it("measures the whole document eagerly after first paint", async () => {
    const doc = makeFakePdfDocument(20, (pageNumber) =>
      pageNumber === 10 ? { width: 827, height: 1180 } : { width: 504, height: 720 },
    );
    const heldWaves: Array<() => void> = [];
    const underlyingGetPage = doc.getPage.getMockImplementation()! as (page: number) => Promise<{
      getViewport: (options: { scale: number }) => { width: number; height: number };
    }>;
    doc.getPage.mockImplementation(async (page: number) => {
      if (page >= 3 && page < 20) await new Promise<void>((resolve) => heldWaves.push(resolve));
      return underlyingGetPage(page);
    });
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    expect(slot(10)).toHaveStyle({ width: "504px", height: "720px" });

    const area = screen.getByTestId("pdf-content-area");
    Object.defineProperty(area, "clientWidth", { value: 1248, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("242.9"));

    await waitFor(() => expect(heldWaves.length).toBeGreaterThan(0));
    for (const resolve of heldWaves.splice(0)) resolve();
    await waitFor(() => expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("148"));
    expect(slot(10)).toHaveStyle({ width: "1224px", height: "1746px" });
    expect(slot(9)).toHaveStyle({ width: "746px", height: "1066px" });
    expect(slot(11)).toHaveStyle({ width: "746px", height: "1066px" });
    const measuredPages = new Set(doc.getPage.mock.calls.map(([page]) => page));
    expect(measuredPages).toEqual(new Set(Array.from({ length: 20 }, (_, i) => i + 1)));
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

    await userEvent.click(screen.getByRole("button", { name: "probe-dark" }));
    expect(screen.getByTestId("pdf-document").style.filter).toBe("");
    expect(screen.queryByTestId("pdf-theme-tint")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "probe-invert" }));
    expect(screen.getByTestId("pdf-document").style.filter).toBe("invert(1) hue-rotate(180deg)");

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

    expect(doc.renderOptions.length).toBeGreaterThan(0);
    for (const call of doc.renderOptions) {
      expect(call.smartColors).toBeUndefined();
    }

    await userEvent.click(screen.getByRole("button", { name: "probe-dark" }));
    await waitFor(() => expect(doc.renderOptions.at(-1)?.smartColors).toBeDefined());
    const smart = doc.renderOptions.at(-1)?.smartColors as
      | { background: number[]; text: number[] }
      | undefined;
    expect(smart?.background[0]).toBeCloseTo(16 / 255, 3);
    expect(smart?.text[0]).toBeCloseTo(228 / 255, 3);

    await userEvent.click(screen.getByRole("button", { name: "probe-default" }));
    await waitFor(() => expect(doc.renderOptions.at(-1)?.smartColors).toBeUndefined());
  });

  it("placeholders pending page slots with the dark palette in Smart Dark (issue #67)", async () => {
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

    const wrapper = document.querySelector("[data-pdf-page-wrapper='1']");
    expect(wrapper).not.toBeNull();
    expect((wrapper as HTMLElement).style.backgroundColor).toBe("");

    await userEvent.click(screen.getByRole("button", { name: "probe-dark" }));
    await waitFor(() => {
      const darkWrapper = document.querySelector("[data-pdf-page-wrapper='1']");
      expect((darkWrapper as HTMLElement | null)?.style.backgroundColor).toBe("rgb(16, 16, 19)");
    });

    await userEvent.click(screen.getByRole("button", { name: "probe-default" }));
    await waitFor(() => {
      const plainWrapper = document.querySelector("[data-pdf-page-wrapper='1']");
      expect((plainWrapper as HTMLElement | null)?.style.backgroundColor).toBe("");
    });

    expect((slot(2) as HTMLElement).style.backgroundColor).toBe("rgb(255, 255, 255)");
    await userEvent.click(screen.getByRole("button", { name: "probe-dark" }));
    await waitFor(() => {
      expect((slot(2) as HTMLElement).style.backgroundColor).toBe("rgb(16, 16, 19)");
    });
    await userEvent.click(screen.getByRole("button", { name: "probe-default" }));
    await waitFor(() => {
      expect((slot(2) as HTMLElement).style.backgroundColor).toBe("rgb(255, 255, 255)");
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

    // Assert synchronously: the mocked open resolves on a microtask, so awaiting lets it swap away first.
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
    firePreload(slot(2) as Element, true);
    await waitFor(() => expect(slot(2)).toHaveAttribute("data-render-state", "rendered"));
    expect(screen.getByTestId("pdf-reader").getAttribute("data-pdf-bitmap-cache")).toMatch(
      /^2:[1-9]\d*$/,
    );

    view.rerenderBook({ book: secondBook });
    await screen.findAllByTestId("pdf-canvas");

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
    expect(canvasPages()).toEqual(["1"]);

    fireVisible(slot(2) as Element, true);
    fireVisible(slot(3) as Element, true);
    firePreload(slot(4) as Element, true);
    firePreload(slot(5) as Element, true);

    await waitFor(() => expect(canvasPages()).toEqual(["1", "2", "3", "4"]));
    await waitFor(() => expect(slot(3)).toHaveAttribute("data-render-state", "rendered"));
    expect(slot(5)).toHaveAttribute("data-render-state", "unloaded");
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

    // PDF.js pipelines pages: while page 1's heavy raster is held, page 3 must still start.
    fireVisible(slot(3) as Element, true);
    await waitFor(() => expect(canvasPages()).toEqual(["1", "3"]));

    fireVisible(slot(4) as Element, true);
    expect(canvasPages()).toEqual(["1", "3"]);

    doc.releaseRender(1);
    await waitFor(() => expect(canvasPages()).toEqual(["1", "3", "4"]));

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
    expect(slot(2)).toHaveAttribute("data-render-state", "unloaded");
    expect(slot(2)).toHaveStyle({ height: "792px" });
    expect((slot(2) as HTMLElement).style.backgroundColor).toBe("rgb(255, 255, 255)");
  });

  it("retains rendered pages within three of the visible range (Papers ring)", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(100) as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

    await renderLoadedReader();
    fireVisible(slot(2) as Element, true);
    fireVisible(slot(5) as Element, true);
    fireVisible(slot(6) as Element, true);
    await waitFor(() => {
      expect(slot(6)).toHaveAttribute("data-render-state", "rendered");
      expect(canvasPages()).toHaveLength(4);
    });

    fireVisible(slot(5) as Element, false);
    fireVisible(slot(6) as Element, false);
    await waitFor(() => expect(canvasPages()).not.toContain("6"));
    expect(canvasPages()).toContain("5");
    expect(canvasPages()).toContain("2");
    expect(slot(5)).toHaveAttribute("data-render-state", "rendered");
    expect(slot(6)).toHaveAttribute("data-render-state", "unloaded");
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
    const area = screen.getByTestId("pdf-content-area");
    Object.defineProperty(area, "clientWidth", { value: 3816, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", "3792"));

    for (let page = 2; page <= 8; page++) {
      fireVisible(slot(page) as Element, true);
    }

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
    expect(screen.getByTestId("pdf-reader").getAttribute("data-pdf-bitmap-cache")).toMatch(/^2:/);

    fireVisible(slot(2) as Element, false);
    firePreload(slot(2) as Element, false);
    await waitFor(() => expect(canvasPages()).not.toContain("2"));

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

    await userEvent.click(screen.getByTestId("pdf-zoom-in"));
    fireVisible(slot(2) as Element, true);
    await waitFor(() => expect(slot(2)).toHaveAttribute("data-render-state", "rendered"));
    expect(page2GetPageCalls()).toBeGreaterThan(callsBeforeZoom);
  });
});

describe("PdfReader scroll tracking", () => {
  /** Loaded reader with a fake scroll container (720px viewport). */
  async function renderScrollableReader(props: { probePage?: number } = {}) {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });
    const container = document.createElement("div");
    const view = renderPdfReader({ scrollContainerRef: { current: container }, ...props });
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

  it("does not scroll back on a stale write for a scroll-reported page", async () => {
    const scrollIntoViewSpy = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    try {
      const { container } = await renderScrollableReader({ probePage: 2 });
      await screen.findByTestId("pdf-page-indicator");
      scrollTo(container, 810);
      await waitFor(() =>
        expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
      );
      scrollTo(container, 1620);
      await waitFor(() =>
        expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 3"),
      );
      scrollIntoViewSpy.mockClear();

      await userEvent.click(screen.getByTestId("probe-position-2"));
      await waitFor(() =>
        expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
      );
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    } finally {
      scrollIntoViewSpy.mockRestore();
    }
  });

  it("re-anchors on navigation to a recently scroll-reported page", async () => {
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

      await userEvent.click(screen.getByTestId("pdf-prev"));
      await waitFor(() =>
        expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3"),
      );
      expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
      expect(scrollIntoViewSpy.mock.contexts[0]).toBe(slot(1));
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

    const area = screen.getByTestId("pdf-content-area");
    Object.defineProperty(area, "clientWidth", { value: 1248, configurable: true });
    window.dispatchEvent(new Event("resize"));

    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", "1224"));
    expect(slot(1)).toHaveStyle({ width: "1224px" });
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

    await waitFor(() => expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("100"));
    expect(slot(1)).toHaveStyle({ width: "612px" });
    expect(slot(2)).toHaveStyle({ width: "1224px" });
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

    await userEvent.click(screen.getByTestId("pdf-next"));
    expect(await screen.findByTestId("pdf-retry-2")).toBeInTheDocument();
    expect(slot(2)).toHaveAttribute("data-render-state", "error");

    await userEvent.click(screen.getByTestId("pdf-next"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "3"),
    );

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
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("12");
    expect(screen.getByTestId("pdf-zoom-out")).toBeDisabled();

    for (let i = 0; i < 20; i++) fireEvent.keyDown(window, { key: "+" });
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

describe("PdfReader page field", () => {
  async function renderThreePageReader() {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });
    await renderLoadedReader();
  }

  it("selects the whole value on focus and tracks live navigation", async () => {
    await renderThreePageReader();
    const input = screen.getByTestId("pdf-page-input") as HTMLInputElement;
    expect(input).toHaveValue("1");
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("autocomplete", "off");

    act(() => {
      input.focus();
    });
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(1);

    await userEvent.click(screen.getByTestId("pdf-next"));
    await waitFor(() => expect(input).toHaveValue("2"));
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3");
  });

  it("jumps to a typed page on Enter and scrolls it to the top", async () => {
    const scrollIntoViewSpy = vi
      .spyOn(HTMLElement.prototype, "scrollIntoView")
      .mockImplementation(() => {});
    try {
      await renderThreePageReader();
      scrollIntoViewSpy.mockClear();

      const input = screen.getByTestId("pdf-page-input");
      await userEvent.clear(input);
      await userEvent.type(input, "3{Enter}");

      await waitFor(() =>
        expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "3"),
      );
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 3");
      expect(input).toHaveValue("3");
      expect(scrollIntoViewSpy.mock.contexts[0]).toBe(slot(3));
      expect(scrollIntoViewSpy.mock.calls[0]?.[0]).toEqual({
        block: "start",
        inline: "nearest",
      });
    } finally {
      scrollIntoViewSpy.mockRestore();
    }
  });

  it("commits a changed value on blur", async () => {
    await renderThreePageReader();
    const input = screen.getByTestId("pdf-page-input");
    await userEvent.clear(input);
    await userEvent.type(input, "2");
    await userEvent.tab();

    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "2"),
    );
    expect(input).toHaveValue("2");
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3");
  });

  it("discards the edit on Escape without jumping", async () => {
    await renderThreePageReader();
    const input = screen.getByTestId("pdf-page-input");
    await userEvent.clear(input);
    await userEvent.type(input, "3{Escape}");

    expect(input).toHaveValue("1");
    expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "1");
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3");
  });

  it("silently keeps the current page for empty or non-numeric input", async () => {
    await renderThreePageReader();
    const input = screen.getByTestId("pdf-page-input");

    await userEvent.clear(input);
    await userEvent.type(input, "{Enter}");
    expect(input).toHaveValue("1");
    expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "1");

    await userEvent.clear(input);
    await userEvent.type(input, "abc{Enter}");
    expect(input).toHaveValue("1");
  });

  it("clamps typed values onto the document's page range", async () => {
    await renderThreePageReader();
    const input = screen.getByTestId("pdf-page-input");

    await userEvent.clear(input);
    await userEvent.type(input, "99{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "3"),
    );
    expect(input).toHaveValue("3");

    await userEvent.clear(input);
    await userEvent.type(input, "0{Enter}");
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "1"),
    );
    expect(input).toHaveValue("1");
  });

  it("disables the field until the reader layout is ready", () => {
    const props = {
      pageNumber: 1,
      pageCount: 3,
      zoomMode: "custom" as const,
      zoomScale: 1,
      canZoomIn: true,
      canZoomOut: true,
      onPrev: () => {},
      onNext: () => {},
      onZoomIn: () => {},
      onZoomOut: () => {},
      onSelectFit: () => {},
      onSetZoom: () => {},
      onSetPage: () => {},
    };
    const view = render(<PdfToolbar {...props} pageEntryDisabled />);
    expect(screen.getByTestId("pdf-page-input")).toBeDisabled();
    view.rerender(<PdfToolbar {...props} />);
    expect(screen.getByTestId("pdf-page-input")).toBeEnabled();
  });

  async function focusPageInput() {
    const input = screen.getByTestId("pdf-page-input") as HTMLInputElement;
    act(() => {
      input.focus();
    });
    return input;
  }

  it("steps forward and back with the arrow keys while focused", async () => {
    await renderThreePageReader();
    const input = await focusPageInput();

    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "2"),
    );
    expect(input).toHaveValue("2");

    fireEvent.keyDown(input, { key: "ArrowUp" });
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "1"),
    );
    expect(input).toHaveValue("1");
  });

  it("steps one page per wheel tick in either direction while focused", async () => {
    await renderThreePageReader();
    const input = await focusPageInput();

    fireEvent.wheel(input, { deltaY: 100 });
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "2"),
    );

    fireEvent.wheel(input, { deltaY: -100 });
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "1"),
    );
  });

  it("ignores wheel ticks over the unfocused field", async () => {
    await renderThreePageReader();
    const input = screen.getByTestId("pdf-page-input");

    fireEvent.wheel(input, { deltaY: 100 });

    expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "1");
    expect(input).toHaveValue("1");
  });

  it("ignores modified wheel ticks that belong to zoom", async () => {
    await renderThreePageReader();
    const input = await focusPageInput();

    fireEvent.wheel(input, { deltaY: 100, ctrlKey: true });
    fireEvent.wheel(input, { deltaY: 100, metaKey: true });
    fireEvent.wheel(input, { deltaY: 100, altKey: true });

    expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "1");
    expect(input).toHaveValue("1");
  });

  it("ignores a micro wheel tick below the step threshold", async () => {
    await renderThreePageReader();
    const input = await focusPageInput();

    fireEvent.wheel(input, { deltaY: 5 });

    expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "1");
    expect(input).toHaveValue("1");
  });

  it("stops stepping at the page bounds", async () => {
    await renderThreePageReader();
    const input = await focusPageInput();

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "1");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "3"),
    );

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "3");
    expect(input).toHaveValue("3");
  });
});

describe("PdfReader controls docking", () => {
  async function renderWithHeaderHost() {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });

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

      await userEvent.click(screen.getByTestId("pdf-next"));
      await waitFor(() =>
        expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "2"),
      );
      scrollIntoViewSpy.mockClear();

      await userEvent.click(screen.getByTestId("pdf-zoom-in"));
      expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);
      expect(scrollIntoViewSpy.mock.contexts[0]).toBe(slot(2));
      expect(scrollIntoViewSpy.mock.calls[0]?.[0]).toEqual({
        block: "start",
        inline: "nearest",
      });

      scrollIntoViewSpy.mockClear();
      await waitFor(() => expect(slot(2)).toHaveAttribute("data-render-state", "rendered"));
      expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    } finally {
      scrollIntoViewSpy.mockRestore();
    }
  });

  it("never paints a superseded render over the current one (scroll artifact race)", async () => {
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
    await waitFor(() => expect(pending).toHaveLength(3));
    for (const resolve of pending.splice(0)) resolve(gatedPage);

    await screen.findByTestId("pdf-canvas");
    expect(pending).toHaveLength(1);
    const [staleRender] = pending.splice(0) as [(page: unknown) => void];

    await userEvent.click(screen.getByTestId("pdf-zoom-in"));
    await waitFor(() => expect(pending).toHaveLength(1));
    const [freshRender] = pending.splice(0) as [(page: unknown) => void];

    freshRender(gatedPage);
    await waitFor(() =>
      expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", String(612 * 1.25)),
    );
    expect(gatedPage.render).toHaveBeenCalledTimes(1);

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
    expect(slot(1)).toHaveStyle({ width: "918px" });
    expect(slot(3)).toHaveStyle({ height: "1188px" });

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

    await userEvent.clear(input);
    await userEvent.type(input, "99999{Enter}");
    expect(input).toHaveValue("10000");

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

    fireEvent.wheel(container, { deltaY: -100, ctrlKey: true, clientX: 300, clientY: 300 });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("120");

    const documentEl = screen.getByTestId("pdf-document");
    expect(documentEl).toHaveStyle({ transform: "scale(1.2)", transformOrigin: "300px 300px" });
    expect(doc.scales).not.toContain(1.2);
    expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("width", "612");

    fireEvent.wheel(container, { deltaY: -30, ctrlKey: true, clientX: 300, clientY: 300 });
    expect(Number((screen.getByTestId("pdf-zoom-input") as HTMLInputElement).value)).toBeCloseTo(
      100 * 1.2 ** 1.3,
      1,
    );

    await settle();
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("126.7");
    await waitFor(() => expectCanvasWidthNear(612 * 1.2 ** 1.3));
    expect(doc.scales.some((scale) => Math.abs(scale - 1.2 ** 1.3) < 1e-9)).toBe(true);
    expect(documentEl.style.transform).toBe("");

    fireEvent.keyDown(window, { key: "-" });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("125");

    fireEvent.wheel(container, { deltaY: -120 });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("125");
  });

  it("caps one wheel event at three notches and clamps to the zoom bounds", async () => {
    const container = document.createElement("div");
    await renderZoomableReader(container);

    fireEvent.wheel(container, { deltaY: -50_000, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("172.8");
    await settle();

    const input = screen.getByTestId("pdf-zoom-input");
    await userEvent.clear(input);
    await userEvent.type(input, "99999{Enter}");
    expect(input).toHaveValue("10000");
    fireEvent.wheel(container, { deltaY: -500, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(input).toHaveValue("10000");
    await settle();
    expect(input).toHaveValue("10000");
  });

  // Under load (#205) the fit scale reaches the wheel handler late, so an early wheel
  // would multiply a stale base; wait for the fit commit first.
  it("multiplies the derived fit scale on the first wheel tick out of a fit mode", async () => {
    const container = document.createElement("div");
    const { doc } = await renderZoomableReader(container);

    const area = screen.getByTestId("pdf-content-area");
    Object.defineProperty(area, "clientWidth", { value: 1248, configurable: true });
    window.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("200"));
    await waitFor(() => expect(doc.scales).toContain(2));

    fireEvent.wheel(container, { deltaY: -100, ctrlKey: true, clientX: 10, clientY: 10 });
    await settle();
    await waitFor(() => expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("240"), {
      timeout: 5000,
    });
    expect(screen.getByTestId("pdf-toolbar")).toHaveAttribute("data-pdf-zoom-mode", "custom");
    await waitFor(() => expectCanvasWidthNear(612 * 2.4));
    expect(doc.scales).toContain(2.4);
  }, 15000);

  it("flushes a pending wheel gesture immediately when another zoom action runs", async () => {
    const container = document.createElement("div");
    const { doc } = await renderZoomableReader(container);

    fireEvent.wheel(container, { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
    fireEvent.wheel(container, { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("144");

    fireEvent.keyDown(window, { key: "+" });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("150");
    await waitFor(() => expectCanvasWidthNear(612 * 1.5));
    expect(screen.getByTestId("pdf-document").style.transform).toBe("");

    const scalesBefore = doc.scales.length;
    await settle();
    expect(doc.scales.length).toBe(scalesBefore);
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("150");
  });

  it("keeps the point under the cursor through a wheel zoom that crosses the viewport extent", async () => {
    const container = document.createElement("div");
    await renderZoomableReader(container);
    stubScrollGeometry(container, screen.getByTestId("pdf-document"));
    // The old MAX(viewport, content) denominator made the cursor point drift (north-west in, south-east out).
    Object.defineProperty(container, "clientWidth", { value: 800, configurable: true });
    Object.defineProperty(container, "clientHeight", { value: 800, configurable: true });
    scrollTo(container, 0);

    const cursorX = 200;
    const cursorY = 200;
    fireEvent.wheel(container, { deltaY: -300, ctrlKey: true, clientX: cursorX, clientY: cursorY });
    await settle();

    const newScale = Number((screen.getByTestId("pdf-zoom-input") as HTMLInputElement).value) / 100;
    expect(newScale).toBeGreaterThan(1.7);
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

    // "scaled" (not final) proves the previous bitmap is on screen through the commit.
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

    doc.releaseRender(1);
    doc.releaseRender(2);
    await waitFor(() => {
      expect(page1).toHaveAttribute("data-pdf-render-quality", "final");
      expect(page2).toHaveAttribute("data-pdf-render-quality", "final");
    });
    expect(page3).toHaveAttribute("data-pdf-render-quality", "scaled");
  });

  it("cancels the pending zoom commit when unmounted mid-gesture", async () => {
    const container = document.createElement("div");
    const { doc, view } = await renderZoomableReader(container);
    fireEvent.wheel(container, { deltaY: -100, ctrlKey: true, clientX: 0, clientY: 0 });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("120");

    const rendersBefore = doc.renderOptions.length;
    view.unmount();
    await settle();
    expect(doc.renderOptions).toHaveLength(rendersBefore);
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
    // Live viewport geometry: rect.top must move with scrollTop the way a browser reports it.
    return Object.assign(view, { container });
  }

  it("presents only the selected page, fit inside the area", async () => {
    await renderPresentingReader();

    expect(screen.getByTestId("pdf-reader")).toHaveAttribute("data-pdf-presentation", "true");
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
    expect(slot(1)).toBeNull();
    expect(slot(3)).toBeNull();

    fireVisible(slot(2) as Element, true);
    await waitFor(() => expect(slot(2)).toHaveStyle({ width: "1200px", height: "600px" }));
  });

  it("keeps the current page on enter and restores the zoom state on exit", async () => {
    const view = await renderPresentingReader({ presentationMode: false }, undefined, 0);
    expect(screen.getByTestId("pdf-toolbar")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("pdf-next"));
    await userEvent.click(screen.getByTestId("pdf-zoom-in"));
    await userEvent.click(screen.getByTestId("pdf-zoom-in"));
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("150");

    view.rerenderBook({ presentationMode: true });
    expect(screen.getByTestId("pdf-reader")).toHaveAttribute("data-pdf-presentation", "true");
    expect(screen.queryByTestId("pdf-toolbar")).toBeNull();
    expect(screen.getByTestId("pdf-presentation-bar")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );
    expect(slot(2)).toHaveStyle({ height: "612px" });

    view.rerenderBook({ presentationMode: false });
    expect(screen.queryByTestId("pdf-presentation-bar")).toBeNull();
    expect(screen.getByTestId("pdf-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("150");
  });

  it("keeps the zoom shortcuts live while presenting, even with the book preference on", async () => {
    await renderPresentingReader({ preferencesPatch: { bookMode: true } });
    fireEvent.click(screen.getByText("probe-preferences"));

    setPdfZoomTelemetryEnabled(true);
    clearPdfZoomLog();
    fireEvent.keyDown(window, { key: "-", ctrlKey: true });
    const lastZoomSample = () =>
      (
        JSON.parse(dumpPdfZoomLog()) as { samples: { zoomMode: string; zoomLevel: number }[] }
      ).samples.at(-1);
    expect(lastZoomSample()).toMatchObject({ zoomMode: "custom", zoomLevel: 0.75 });
    fireEvent.keyDown(window, { key: "+", ctrlKey: true });
    expect(lastZoomSample()).toMatchObject({ zoomMode: "custom", zoomLevel: 1 });
    setPdfZoomTelemetryEnabled(false);
  });

  it("stays on the page reached in presentation after exiting", async () => {
    const view = await renderPresentingReader({ presentationMode: false }, undefined, 0);
    // jsdom rects are all zero, which would make the scroll anchor always name page 1.
    stubScrollGeometry(view.container, screen.getByTestId("pdf-document"));
    await userEvent.click(screen.getByTestId("pdf-next"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );

    view.rerenderBook({ presentationMode: true });
    await waitFor(() => expect(screen.getByTestId("pdf-presentation-bar")).toBeInTheDocument());

    await userEvent.click(screen.getByTestId("pdf-pres-next"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 3"),
    );

    view.rerenderBook({ presentationMode: false });
    await waitFor(() => expect(screen.queryByTestId("pdf-presentation-bar")).toBeNull());

    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 3"),
    );
    expect(view.container.scrollTop).toBeGreaterThan(0);
    expect(slot(3)).not.toBeNull();
  });

  it("returns to the entry page when presentation is left without flipping", async () => {
    const view = await renderPresentingReader({ presentationMode: false }, undefined, 0);
    stubScrollGeometry(view.container, screen.getByTestId("pdf-document"));
    await userEvent.click(screen.getByTestId("pdf-next"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );

    view.rerenderBook({ presentationMode: true });
    await waitFor(() => expect(screen.getByTestId("pdf-presentation-bar")).toBeInTheDocument());
    // jsdom cannot shrink the scroll range, so apply the clamp a browser applies.
    view.container.scrollTop = 0;

    view.rerenderBook({ presentationMode: false });
    await waitFor(() => expect(screen.queryByTestId("pdf-presentation-bar")).toBeNull());

    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );
    expect(view.container.scrollTop).toBeGreaterThan(0);
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

  it("jumps to a typed page on Enter", async () => {
    await renderPresentingReader();
    const input = screen.getByTestId("pdf-page-input");
    await userEvent.clear(input);
    await userEvent.type(input, "3{Enter}");

    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 3"),
    );
    expect(input).toHaveValue("3");
    expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-pdf-page", "3");
  });

  it("still steps pages with prev and next around the field", async () => {
    await renderPresentingReader();
    const input = screen.getByTestId("pdf-page-input");

    await userEvent.click(screen.getByTestId("pdf-pres-next"));
    await waitFor(() => expect(input).toHaveValue("2"));
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3");

    await userEvent.click(screen.getByTestId("pdf-pres-prev"));
    await waitFor(() => expect(input).toHaveValue("1"));
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3");
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

    await waitFor(() => expect(doc.renderPages.filter((page) => page === 2)).toHaveLength(1));
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3");

    await userEvent.click(screen.getByTestId("pdf-pres-next"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );
    await screen.findByTestId("pdf-canvas");
    expect(doc.renderPages.filter((page) => page === 2)).toHaveLength(1);
  });
});
