import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { useMemo, useState, type RefObject } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

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

import { PdfBookView } from "@/components/reader/pdf/PdfBookView";
import { PdfReader, type PdfReaderProps } from "@/components/reader/pdf/PdfReader";
import type { PdfBookTurnAdapter } from "@/components/reader/pdf/pdfBookTurn";
import type { ReaderAdapter } from "@/components/reader/readerModel";
import { EMPTY_HIGHLIGHT_OVERRIDES } from "@/lib/highlightPalette";
import { READER_SETTINGS_STORAGE_KEY } from "@/lib/readerSettings";
import { PAGE_GAP_PX, type PageSize } from "@/components/reader/pdf/pdfLayout";
import { pageToPosition, positionToPage } from "@/components/reader/pdf/pdfPages";
import { closePdfDocument, openPdfDocumentFromBook } from "@/lib/pdf/pdfEngine";
import { ShortcutProvider } from "@/state/ShortcutProvider";
import { ReaderProvider } from "@/state/ReaderProvider";
import { DEFAULT_READER_PREFERENCES, useReader, type ReaderPreferences } from "@/state/readerState";
import { makeAnnotation, makeBook } from "./factories";
import { invokeMock, mockInvoke } from "./mocks/bridge";
import { makeDomRect, scrollTo, stubScrollGeometry } from "./mocks/dom";
import { makeFakePdfDocument } from "./mocks/pdfEngine";

const openDocumentMock = vi.mocked(openPdfDocumentFromBook);
const closeDocumentMock = vi.mocked(closePdfDocument);

type EngineDocument = Awaited<ReturnType<typeof openPdfDocumentFromBook>>;

const pdfBook = makeBook({
  id: 7,
  format: "pdf",
  path: "/tmp/library/minimal.pdf",
  title: "A Minimal PDF",
});

/** Button that patches reader preferences through the real provider state. */
function PreferenceProbe({ label, patch }: { label: string; patch: Partial<ReaderPreferences> }) {
  const { setPreferences } = useReader();
  return (
    <button type="button" onClick={() => setPreferences(patch)}>
      {label}
    </button>
  );
}

/** Button that writes a raw reading position — the shell's Home/End do the same. */
function PositionProbe({ page, pageCount }: { page: number; pageCount: number }) {
  const { setPosition } = useReader();
  return (
    <button
      type="button"
      data-testid={`probe-position-page-${page}`}
      onClick={() => setPosition(pageToPosition(page, pageCount))}
    >
      position-{page}
    </button>
  );
}

/**
 * Mounts the real reader harness (same providers, engine mock, and bridge
 * fake as PdfReader.test.tsx) with a scroll container of the reference
 * viewport height (720) and no saved position unless one is named.
 */
function renderBookReader(
  savedPage: number | null = null,
  readerProps: Partial<PdfReaderProps> = {},
  storedPreferences: Partial<ReaderPreferences> = {},
) {
  if (Object.keys(storedPreferences).length > 0) {
    window.localStorage.setItem(
      READER_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        preferences: { ...DEFAULT_READER_PREFERENCES, ...storedPreferences },
        themePinned: true,
      }),
    );
  }
  mockInvoke({
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
  });
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { value: 720, configurable: true });
  const scrollContainerRef: RefObject<HTMLElement | null> = { current: container };
  const view = render(
    <ShortcutProvider>
      <ReaderProvider>
        <PdfReader book={pdfBook} scrollContainerRef={scrollContainerRef} {...readerProps} />
        <PreferenceProbe label="book-mode-on" patch={{ bookMode: true }} />
        <PreferenceProbe label="book-mode-off" patch={{ bookMode: false }} />
      </ReaderProvider>
    </ShortcutProvider>,
  );
  return { ...view, container };
}

/** Measured content width of the reference conditions (fit inputs). */
function stubContentWidth(width = 1248): void {
  Object.defineProperty(screen.getByTestId("pdf-content-area"), "clientWidth", {
    value: width,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));
}

function bookPage(pageNumber: number): HTMLElement {
  const element = document.querySelector(`[data-pdf-book-page="${pageNumber}"]`);
  if (!element) throw new Error(`no book page ${pageNumber}`);
  return element as HTMLElement;
}

function styleNumber(element: HTMLElement, property: "left" | "top" | "width" | "height"): number {
  return Number.parseFloat(element.style[property]);
}

function slot(pageNumber: number): HTMLElement | null {
  return document.querySelector(`[data-pdf-slot="${pageNumber}"]`);
}

beforeEach(() => {
  invokeMock.mockReset();
  openDocumentMock.mockReset();
  closeDocumentMock.mockReset();
});

afterEach(() => {
  // Spies (e.g. the per-test matchMedia stub) restore; the module-level
  // engine mocks only clear their call history.
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("PdfReader book mode", () => {
  it("renders the cover page alone at fit-the-pair, without the scroll view", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);

    renderBookReader(null);
    fireEvent.click(screen.getByText("book-mode-on"));

    const book = await screen.findByTestId("pdf-book-view");
    // The scroll view's document surface is not mounted beside the book.
    expect(screen.queryByTestId("pdf-document")).toBeNull();

    // Measured area 1248x720, cover 612x792pt: the height axis binds the
    // fit (Papers margin 2*12), so the page renders 696 CSS px tall.
    stubContentWidth();
    await waitFor(() => expect(book).toHaveAttribute("data-pdf-book-rendered", "1"));

    const page1 = bookPage(1);
    expect(book.querySelectorAll("[data-pdf-book-page]")).toHaveLength(1);
    expect(styleNumber(page1, "left")).toBe(0);
    expect(styleNumber(page1, "top")).toBe(0);
    // 720 - 2*12 = 696 px tall; width 612 * 696/792 = 537.82 rounds to the
    // whole-pixel page size (displayedSizes/scaledPixels).
    expect(styleNumber(page1, "height")).toBe(696);
    expect(styleNumber(page1, "width")).toBe(538);
    // Contained in the viewport on both axes (the pair's fit follows the
    // same containment in the tests below).
    expect(styleNumber(page1, "height")).toBeLessThanOrEqual(720);
    expect(styleNumber(page1, "width")).toBeLessThanOrEqual(1248);

    const canvas = page1.querySelector("[data-testid='pdf-book-canvas']");
    expect(canvas).not.toBeNull();
    expect(canvas).toHaveAttribute("data-pdf-page", "1");
  });

  it("renders the facing spread of the saved position, rasterizing only its pages", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);

    renderBookReader(2);
    fireEvent.click(screen.getByText("book-mode-on"));
    const book = await screen.findByTestId("pdf-book-view");
    stubContentWidth();
    await waitFor(() => expect(book).toHaveAttribute("data-pdf-book-rendered", "2,3"));

    // Page 1 is never paired: the restored position 2 shows the facing
    // pair 2|3, laid out by layoutSpread — 538 px pages, 8 px gap.
    expect(book.querySelectorAll("[data-pdf-book-page]")).toHaveLength(2);
    expect(document.querySelector("[data-pdf-book-page='1']")).toBeNull();
    const page2 = bookPage(2);
    const page3 = bookPage(3);
    expect(styleNumber(page2, "left")).toBe(0);
    expect(styleNumber(page3, "left")).toBe(546);
    expect(styleNumber(page2, "height")).toBe(696);
    expect(styleNumber(page3, "height")).toBe(696);
    // Both pages fully visible: the spread fits the viewport (1084x696
    // inside the measured 1248x720 area).
    expect(book).toHaveStyle({ width: "1084px", height: "696px" });
    expect(styleNumber(book, "width")).toBeLessThanOrEqual(1248);
    expect(styleNumber(book, "height")).toBeLessThanOrEqual(720);

    // Render budget: only the spread's two pages rasterize — never the
    // whole document — through the existing canvas pipeline.
    expect([...doc.renderPages].sort()).toEqual([2, 3]);
  });

  it("fits a wide pair to the viewport width with both pages fully visible", async () => {
    const doc = makeFakePdfDocument(3, () => ({ width: 1100, height: 700 }));
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);

    renderBookReader(2);
    fireEvent.click(screen.getByText("book-mode-on"));
    const book = await screen.findByTestId("pdf-book-view");
    stubContentWidth();
    await waitFor(() => expect(book).toHaveAttribute("data-pdf-book-rendered", "2,3"));

    // Wide pair (2208pt): the width axis binds the fit — 1248 - 2*12 =
    // 1224 px at scale 0.5543 — so the pages round to 610x388 px and the
    // spread lands 1228 px wide (the 8px gap does not scale with the
    // pages), still inside the viewport on both axes.
    expect(book).toHaveStyle({ width: "1228px", height: "388px" });
    const page2 = bookPage(2);
    const page3 = bookPage(3);
    expect(styleNumber(page2, "left")).toBe(0);
    expect(styleNumber(page3, "left")).toBe(618);
    expect(styleNumber(page3, "left") + styleNumber(page3, "width")).toBeLessThanOrEqual(1248);
    expect(styleNumber(page2, "height")).toBeLessThanOrEqual(720);
  });

  it("returns the unchanged scroll view off, and reuses document, cache, and worker on return", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    // Engine rasters at the fit-the-pair scale (720-24 px tall pages).
    const bookRasters = () => doc.scales.filter((value) => Math.abs(value - 696 / 792) < 1e-9);

    const { container } = renderBookReader(2);
    fireEvent.click(screen.getByText("book-mode-on"));
    const book = await screen.findByTestId("pdf-book-view");
    stubContentWidth();
    await waitFor(() => expect(book).toHaveAttribute("data-pdf-book-rendered", "2,3"));
    expect(bookRasters()).toHaveLength(2);

    // Off: the continuous scroll view returns unchanged — its document
    // surface with the whole slot set — and nothing closes the document.
    // The scroll visit's own rasters are held open: they target the pages
    // at the scroll view's scale (a different cache identity, so they
    // legitimately supersede the spread's bitmaps) and would only mask
    // what this test observes — the spread's bitmaps still being there
    // when book mode comes back.
    const underlyingGetPage = doc.getPage.getMockImplementation() as unknown as (
      pageNumber: number,
    ) => Promise<{ getViewport: (options: { scale: number }) => unknown }>;
    doc.getPage.mockImplementation(async (pageNumber: number) => {
      const page = await underlyingGetPage(pageNumber);
      return {
        getViewport: page.getViewport,
        render: () => ({ promise: new Promise<never>(() => {}), cancel: vi.fn() }),
      };
    });
    fireEvent.click(screen.getByText("book-mode-off"));
    expect(screen.queryByTestId("pdf-book-view")).toBeNull();
    expect(screen.getByTestId("pdf-reader")).toHaveAttribute("data-pdf-book-mode", "false");
    await screen.findByTestId("pdf-document");
    expect(slot(1)).not.toBeNull();
    expect(slot(2)).not.toBeNull();
    expect(slot(3)).not.toBeNull();
    await screen.findByTestId("pdf-canvas");
    // The spread's two bitmaps are still the reader's cache contents —
    // the book view stored into the same instance the scroll view reads.
    expect(screen.getByTestId("pdf-reader").getAttribute("data-pdf-bitmap-cache")).toMatch(/^2:/);
    // The scroll view re-anchors from its own geometry: with the container
    // scrolled to the page the book was showing (what the shell's restore
    // scroll does), the position stays on page 2 through the visit.
    stubScrollGeometry(container, screen.getByTestId("pdf-document"));
    scrollTo(container, 810);
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );

    // On again: both spread pages blit from that cache — no new engine
    // raster at the book scale — and the document was neither re-opened
    // nor closed across the whole journey (the render worker lives with
    // the document handle).
    fireEvent.click(screen.getByText("book-mode-on"));
    const bookAgain = await screen.findByTestId("pdf-book-view");
    stubContentWidth();
    await waitFor(() => expect(bookAgain).toHaveAttribute("data-pdf-book-rendered", "2,3"));
    expect(bookRasters()).toHaveLength(2);
    expect(openDocumentMock).toHaveBeenCalledTimes(1);
    expect(closeDocumentMock).not.toHaveBeenCalled();
  });

  it("hides the toolbar zoom controls while book mode is active and restores them off", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);

    renderBookReader(null);
    // Scroll view first: the Okular-style zoom combo is part of the
    // inline toolbar once the document is interactive.
    await screen.findByTestId("pdf-toolbar");
    expect(screen.getByTestId("pdf-zoom-in")).toBeInTheDocument();
    expect(screen.getByTestId("pdf-zoom-input")).toBeInTheDocument();

    fireEvent.click(screen.getByText("book-mode-on"));
    await screen.findByTestId("pdf-book-view");
    // Book mode is fit-the-pair only: the zoom controls acted on
    // scroll-view-only state, so they are gone while the mode is on.
    // Page navigation stays — the field and indicator still track the
    // position.
    expect(screen.getByTestId("pdf-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("pdf-page-indicator")).toBeInTheDocument();
    expect(screen.queryByTestId("pdf-zoom-in")).toBeNull();
    expect(screen.queryByTestId("pdf-zoom-out")).toBeNull();
    expect(screen.queryByTestId("pdf-zoom-input")).toBeNull();

    fireEvent.click(screen.getByText("book-mode-off"));
    await waitFor(() => expect(screen.getByTestId("pdf-zoom-in")).toBeInTheDocument());
    expect(screen.getByTestId("pdf-zoom-input")).toBeInTheDocument();
  });

  it("holds every zoom entry point inert while on and restores the held zoom off", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);

    const { container } = renderBookReader(null);
    await screen.findByTestId("pdf-toolbar");
    // Off: the keyboard steps the zoom — the same keys the gate below covers.
    fireEvent.keyDown(window, { key: "+" });
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("125");

    fireEvent.click(screen.getByText("book-mode-on"));
    await screen.findByTestId("pdf-book-view");
    // On: the zoom combo is hidden AND every entry point is inert — the
    // plain and Ctrl steps, the fit modes, the reset, and the Ctrl+wheel
    // gesture — so nothing mutates the scroll-view zoom the reader holds
    // for its return.
    fireEvent.keyDown(window, { key: "-" });
    fireEvent.keyDown(window, { key: "+", ctrlKey: true });
    fireEvent.keyDown(window, { key: "0", ctrlKey: true });
    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    fireEvent.keyDown(window, { key: "2", ctrlKey: true });
    fireEvent.keyDown(window, { key: "3", ctrlKey: true });
    fireEvent.wheel(container, { ctrlKey: true, deltaY: -100 });

    fireEvent.click(screen.getByText("book-mode-off"));
    await waitFor(() => expect(screen.getByTestId("pdf-zoom-input")).toBeInTheDocument());
    expect(screen.getByTestId("pdf-zoom-input")).toHaveValue("125");
    expect(screen.getByTestId("pdf-toolbar")).toHaveAttribute("data-pdf-zoom-mode", "custom");
  });
});

describe("PdfBookView turn zones", () => {
  const letterSizes = (pageCount: number): PageSize[] =>
    Array.from({ length: pageCount }, (_, index) => ({
      pageNumber: index + 1,
      width: 612,
      height: 792,
    }));

  /** A fixed 6-page fake document handle for direct PdfBookView mounts. */
  const bookDocument = () => makeFakePdfDocument(6) as unknown as EngineDocument;

  /**
   * Stubs the reduced-motion media query for one render and returns the
   * spy so the test can restore it early if it wants to.
   */
  function stubReducedMotion(matches: boolean) {
    return vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query.includes("prefers-reduced-motion") && matches,
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
  }

  /**
   * Mounts the view with a scripted turn adapter (the AC7 seam): the fake
   * records the call and lands the spread the way the real wiring would —
   * by moving the harness's reading page.
   */
  function renderFakeTurnView(
    adapterFor: (setPage: (page: number) => void) => PdfBookTurnAdapter,
    { initialPage = 2 }: { initialPage?: number } = {},
  ) {
    function Harness() {
      const [page, setPage] = useState(initialPage);
      const adapter = useMemo(() => adapterFor(setPage), [setPage]);
      return (
        <PdfBookView
          document={bookDocument()}
          sizes={letterSizes(6)}
          currentPage={page}
          areaWidth={1248}
          viewportHeight={720}
          highlightFamily="light"
          highlightOverrides={EMPTY_HIGHLIGHT_OVERRIDES}
          turnAdapter={adapter}
        />
      );
    }
    return render(
      <ShortcutProvider>
        <ReaderProvider>
          <Harness />
        </ReaderProvider>
      </ShortcutProvider>,
    );
  }

  /**
   * Mounts the view with no injected adapter (the view creates the real
   * instant one) over the real position model, mirroring how PdfReader
   * derives the current page: a zone click must settle through the
   * position and come back as the applied spread.
   */
  function renderRealTurnView(
    pageCount: number,
    bookTurnRef?: { current: PdfBookTurnAdapter | null },
  ) {
    function Harness() {
      const { position } = useReader();
      return (
        <PdfBookView
          document={bookDocument()}
          sizes={letterSizes(pageCount)}
          currentPage={positionToPage(position, pageCount)}
          areaWidth={1248}
          viewportHeight={720}
          highlightFamily="light"
          highlightOverrides={EMPTY_HIGHLIGHT_OVERRIDES}
          bookTurnRef={bookTurnRef}
        />
      );
    }
    return render(
      <ShortcutProvider>
        <ReaderProvider>
          <Harness />
        </ReaderProvider>
      </ShortcutProvider>,
    );
  }

  function zones(kind: "edge" | "corner", direction: "prev" | "next"): HTMLElement[] {
    return Array.from(
      document.querySelectorAll<HTMLElement>(`[data-pdf-book-turn-${kind}="${direction}"]`),
    );
  }

  /** The one zone of its kind and direction (throws when absent). */
  function zone(kind: "edge" | "corner", direction: "prev" | "next"): HTMLElement {
    const element = zones(kind, direction)[0];
    if (!element) throw new Error(`no ${kind} ${direction} turn zone`);
    return element;
  }

  it("routes edge and corner clicks through the turn adapter and applies the settled spread", () => {
    const advance = vi.fn();
    const retreat = vi.fn();
    renderFakeTurnView((setPage) => ({
      reducedMotion: false,
      advance: () => {
        advance();
        setPage(4);
      },
      retreat: () => {
        retreat();
        setPage(2);
      },
    }));

    // The facing pair [2,3]: one edge strip per page, on its outer edge,
    // plus a bottom-corner triangle per direction on the spread.
    expect(document.querySelectorAll("[data-pdf-book-page]")).toHaveLength(2);
    expect(zones("edge", "prev")).toHaveLength(1);
    expect(zones("edge", "next")).toHaveLength(1);
    expect(zone("edge", "prev").closest("[data-pdf-book-page]")).toHaveAttribute(
      "data-pdf-book-page",
      "2",
    );
    expect(zone("edge", "next").closest("[data-pdf-book-page]")).toHaveAttribute(
      "data-pdf-book-page",
      "3",
    );
    expect(zones("corner", "prev")).toHaveLength(1);
    expect(zones("corner", "next")).toHaveLength(1);

    // The right edge turns forward; the view applies the settled spread.
    fireEvent.click(zone("edge", "next"));
    expect(advance).toHaveBeenCalledTimes(1);
    expect(retreat).not.toHaveBeenCalled();
    expect(document.querySelector("[data-pdf-book-page='4']")).not.toBeNull();
    expect(document.querySelector("[data-pdf-book-page='5']")).not.toBeNull();
    expect(document.querySelector("[data-pdf-book-page='2']")).toBeNull();

    // The bottom-left corner turns back, through the same adapter.
    fireEvent.click(zone("corner", "prev"));
    expect(retreat).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-pdf-book-page='2']")).not.toBeNull();
    expect(document.querySelector("[data-pdf-book-page='3']")).not.toBeNull();
  });

  it("gives the lone cover both outer edges", () => {
    const advance = vi.fn();
    const retreat = vi.fn();
    renderFakeTurnView(
      (setPage) => ({
        reducedMotion: false,
        advance: () => {
          advance();
          setPage(2);
        },
        retreat: () => {
          retreat();
          setPage(2);
        },
      }),
      { initialPage: 1 },
    );

    expect(document.querySelectorAll("[data-pdf-book-page]")).toHaveLength(1);
    // The cover is both the left-most and the right-most page.
    expect(zone("edge", "prev").closest("[data-pdf-book-page]")).toHaveAttribute(
      "data-pdf-book-page",
      "1",
    );
    expect(zone("edge", "next").closest("[data-pdf-book-page]")).toHaveAttribute(
      "data-pdf-book-page",
      "1",
    );
    fireEvent.click(zone("edge", "next"));
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it("leaves interior clicks alone: no turn, no adapter call", () => {
    const advance = vi.fn();
    const retreat = vi.fn();
    renderFakeTurnView(() => ({ reducedMotion: false, advance, retreat }));

    fireEvent.click(bookPage(2));
    fireEvent.click(bookPage(3));
    expect(advance).not.toHaveBeenCalled();
    expect(retreat).not.toHaveBeenCalled();
  });

  it("passes the view's reduced-motion read into the adapter it creates, and a click settles through the position model", () => {
    stubReducedMotion(true);
    const bookTurnRef: { current: PdfBookTurnAdapter | null } = { current: null };
    renderRealTurnView(6, bookTurnRef);

    // The view reads the media query (the adapter never does) and
    // publishes the plumbing.
    expect(screen.getByTestId("pdf-book-view")).toHaveAttribute(
      "data-pdf-book-reduced-motion",
      "true",
    );
    // The registered adapter is the view-created instant one, carrying
    // the flag.
    expect(bookTurnRef.current).not.toBeNull();
    expect(bookTurnRef.current?.reducedMotion).toBe(true);

    // One click: adapter → onSettle → pageToPosition → position context →
    // positionToPage → the applied spread, instantly (Stage 1).
    fireEvent.click(zone("edge", "next"));
    expect(document.querySelector("[data-pdf-book-page='2']")).not.toBeNull();
    expect(document.querySelector("[data-pdf-book-page='3']")).not.toBeNull();
  });

  it("defaults the reduced-motion flag off and nulls the registration on unmount", () => {
    const media = stubReducedMotion(false);
    const bookTurnRef: { current: PdfBookTurnAdapter | null } = { current: null };
    const view = renderRealTurnView(6, bookTurnRef);

    expect(screen.getByTestId("pdf-book-view")).toHaveAttribute(
      "data-pdf-book-reduced-motion",
      "false",
    );
    expect(bookTurnRef.current?.reducedMotion).toBe(false);
    media.mockRestore();

    view.unmount();
    expect(bookTurnRef.current).toBeNull();
  });
});

// tuxbooks-9pr.11: both toggle directions must land on the latest reading
// position — the spread on entry, the settled page's slot on exit.
describe("PdfReader book mode position fidelity", () => {
  /** Content-area width both the scroll view and the spread measure against. */
  const MEASURED_AREA_WIDTH = 1248;

  /** The clientWidth descriptor this describe installed, for restoration. */
  const ownClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");

  afterEach(() => {
    if (ownClientWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", ownClientWidth);
    else delete (HTMLElement.prototype as unknown as { clientWidth?: number }).clientWidth;
  });

  /**
   * Mounts the reader over a `pageCount`-page document with a 720px scroll
   * container and the book-mode probes. The measured content-area width rides
   * a prototype getter because the content area remounts across a book-mode
   * toggle: in a live browser the width is still there after the remount,
   * and an instance-level stub would silently rescale the document on exit.
   */
  async function renderFidelityReader({
    presentationMode = false,
    pageCount = 6,
  }: { presentationMode?: boolean; pageCount?: number } = {}) {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(pageCount) as unknown as EngineDocument);
    mockInvoke({ get_reading_progress: null, save_reading_progress: null });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.testid === "pdf-content-area" ? MEASURED_AREA_WIDTH : 0;
      },
    });
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 720, configurable: true });
    const scrollContainerRef: RefObject<HTMLElement | null> = { current: container };
    const tree = (presenting: boolean) => (
      <ShortcutProvider>
        <ReaderProvider>
          <PdfReader
            book={pdfBook}
            scrollContainerRef={scrollContainerRef}
            presentationMode={presenting}
          />
          <PreferenceProbe label="book-mode-on" patch={{ bookMode: true }} />
          <PreferenceProbe label="book-mode-off" patch={{ bookMode: false }} />
          <PositionProbe page={1} pageCount={pageCount} />
          <PositionProbe page={pageCount} pageCount={pageCount} />
        </ReaderProvider>
      </ShortcutProvider>
    );
    const view = render(tree(presentationMode));
    await screen.findByTestId("pdf-canvas");
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent(`Page 1 of ${pageCount}`),
    );
    stubScrollInvariantGeometry(container);
    return {
      ...view,
      container,
      setPresentationMode: (on: boolean) => view.rerender(tree(on)),
    };
  }

  /**
   * Scroll-invariant rects for every element, applied at the prototype so
   * they survive the document view's remount across a book-mode toggle — an
   * element-level stub dies with the element it was applied to, and jsdom's
   * all-zero rects would then read "document top = scrollTop", i.e. always
   * page 1, into the tracker's first post-exit sample.
   */
  function stubScrollInvariantGeometry(container: HTMLElement): void {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.testid === "pdf-document") return makeDomRect(-container.scrollTop);
      return makeDomRect(0);
    });
  }

  /** Layout top of a page's slot, from the mounted slots' own geometry. */
  function slotTop(pageNumber: number): number {
    let top = 0;
    for (let page = 1; page < pageNumber; page += 1) {
      const element = slot(page);
      if (!element) throw new Error(`no slot ${page}`);
      top += Number.parseFloat(element.style.height) + PAGE_GAP_PX;
    }
    return top;
  }

  /** Let a scroll sample's requestAnimationFrame round run to completion. */
  async function settleScrollSamples(): Promise<void> {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });
  }

  it("round-trips a scrolled page through book mode and back onto its slot", async () => {
    const { container } = await renderFidelityReader();

    // Scroll into page 4: the reading anchor (viewport top + 25%) sits in it.
    scrollTo(container, slotTop(4));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 4 of 6"),
    );

    // Entry lands on the spread that contains the anchor page, not page 1.
    fireEvent.click(screen.getByText("book-mode-on"));
    const book = await screen.findByTestId("pdf-book-view");
    await waitFor(() => expect(book).toHaveAttribute("data-pdf-book-rendered", "4,5"));

    // A clamped scroll while the spread owns the view must not clobber
    // position: the browser shrinks the content to the pair and clamps
    // scrollTop to 0 while the old document element could still answer a
    // sample.
    container.scrollTop = 0;
    fireEvent.scroll(container);
    await settleScrollSamples();
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 4 of 6");

    // On exit the scroll view comes back on page 4's slot top before any
    // scroll event, the policy names the landing, and the tracker's first
    // sample — its enabled gate re-opens with the remount — reads the
    // restored offset instead of zero.
    fireEvent.click(screen.getByText("book-mode-off"));
    await screen.findByTestId("pdf-document");
    expect(container.scrollTop).toBe(slotTop(4));
    expect(screen.getByTestId("pdf-reader")).toHaveAttribute("data-pdf-scroll-policy", "book-exit");
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 4 of 6");

    // The first scroll after the toggle confirms the same page: from a
    // zeroed offset this sample would confirm page 1 into position.
    fireEvent.scroll(container);
    await settleScrollSamples();
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 4 of 6");
  });

  it("round-trips a two-page document through book mode and back onto its slot", async () => {
    const { container } = await renderFidelityReader({ pageCount: 2 });

    // Scroll into page 2: the reading anchor (viewport top + 25%) sits in
    // the trailing page.
    scrollTo(container, slotTop(2));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 2"),
    );

    // Entry shows the spread that contains the anchor page. A two-page
    // document groups as cover alone then the back page alone (the
    // pagination rule), so the anchor's page is its whole spread.
    fireEvent.click(screen.getByText("book-mode-on"));
    const book = await screen.findByTestId("pdf-book-view");
    await waitFor(() => expect(book).toHaveAttribute("data-pdf-book-rendered", "2"));

    // Exit lands on page 2's slot top before any scroll event, and the
    // first scroll confirms it rather than page 1.
    fireEvent.click(screen.getByText("book-mode-off"));
    await screen.findByTestId("pdf-document");
    expect(container.scrollTop).toBe(slotTop(2));
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 2");
    fireEvent.scroll(container);
    await settleScrollSamples();
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 2");
  });

  it("keeps the page a book turn settled on through the round trip", async () => {
    const { container } = await renderFidelityReader();

    // Enter on the spread's anchor page (2|3).
    scrollTo(container, slotTop(2));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 6"),
    );
    fireEvent.click(screen.getByText("book-mode-on"));
    const book = await screen.findByTestId("pdf-book-view");
    await waitFor(() => expect(book).toHaveAttribute("data-pdf-book-rendered", "2,3"));

    // One forward turn: the adapter settles on the next spread's anchor
    // page, which is what the exit must land on.
    const turnForward = document.querySelector('[data-pdf-book-turn-edge="next"]');
    if (!turnForward) throw new Error("no forward turn zone");
    fireEvent.click(turnForward);
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 4 of 6"),
    );
    await waitFor(() => expect(book).toHaveAttribute("data-pdf-book-rendered", "4,5"));

    // The browser clamps the offset while the pair fits the viewport.
    container.scrollTop = 0;
    fireEvent.click(screen.getByText("book-mode-off"));
    await screen.findByTestId("pdf-document");
    expect(container.scrollTop).toBe(slotTop(4));
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 4 of 6");

    fireEvent.scroll(container);
    await settleScrollSamples();
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 4 of 6");
  });

  it("restores the trailing last page at the document end", async () => {
    const { container } = await renderFidelityReader();

    scrollTo(container, slotTop(6));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 6 of 6"),
    );
    fireEvent.click(screen.getByText("book-mode-on"));
    const book = await screen.findByTestId("pdf-book-view");
    // The trailing odd page stands alone in its spread, never padded.
    await waitFor(() => expect(book).toHaveAttribute("data-pdf-book-rendered", "6"));

    container.scrollTop = 0;
    fireEvent.click(screen.getByText("book-mode-off"));
    await screen.findByTestId("pdf-document");
    expect(container.scrollTop).toBe(slotTop(6));
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 6 of 6");

    fireEvent.scroll(container);
    await settleScrollSamples();
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 6 of 6");
  });

  it("re-anchors to the first and last page from the end positions", async () => {
    const { container } = await renderFidelityReader();

    // Position 0 (the shell's Home): the cover round-trips to the top.
    fireEvent.click(screen.getByText("book-mode-on"));
    const book = await screen.findByTestId("pdf-book-view");
    await waitFor(() => expect(book).toHaveAttribute("data-pdf-book-rendered", "1"));
    container.scrollTop = 0;
    fireEvent.click(screen.getByText("book-mode-off"));
    await screen.findByTestId("pdf-document");
    expect(container.scrollTop).toBe(slotTop(1));
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 6");
    fireEvent.scroll(container);
    await settleScrollSamples();
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 6");

    // Position 100 (the shell's End), written while the spread owns the
    // view: the spread follows the position, and the exit restores that
    // page's slot.
    fireEvent.click(screen.getByText("book-mode-on"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-book-view")).toHaveAttribute("data-pdf-book-rendered", "1"),
    );
    fireEvent.click(screen.getByTestId("probe-position-page-6"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-book-view")).toHaveAttribute("data-pdf-book-rendered", "6"),
    );
    container.scrollTop = 0;
    fireEvent.click(screen.getByText("book-mode-off"));
    await screen.findByTestId("pdf-document");
    expect(container.scrollTop).toBe(slotTop(6));
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 6 of 6");
    fireEvent.scroll(container);
    await settleScrollSamples();
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 6 of 6");
  });

  it("keeps the presented page through a book visit and restores it on exit", async () => {
    const { container, setPresentationMode } = await renderFidelityReader();

    scrollTo(container, slotTop(2));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 6"),
    );
    setPresentationMode(true);
    await waitFor(() => expect(screen.getByTestId("pdf-presentation-bar")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("pdf-pres-next"));
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 6"),
    );

    // Book preference on while presenting: presentation wins while active.
    fireEvent.click(screen.getByText("book-mode-on"));
    expect(screen.getByTestId("pdf-reader")).toHaveAttribute("data-pdf-book-mode", "false");

    // Presentation exits into the book view (the preference is on), which
    // must show the presented page's spread — the presentation landing and
    // the book visit must not fight over the page.
    setPresentationMode(false);
    const book = await screen.findByTestId("pdf-book-view");
    await waitFor(() => expect(book).toHaveAttribute("data-pdf-book-rendered", "2,3"));
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 6");
    expect(screen.getByTestId("pdf-reader")).toHaveAttribute("data-pdf-book-mode", "true");

    // Leaving the spread then lands the scroll view on the presented
    // page's slot, the same page presentation would have restored.
    container.scrollTop = 0;
    fireEvent.click(screen.getByText("book-mode-off"));
    await screen.findByTestId("pdf-document");
    expect(container.scrollTop).toBe(slotTop(3));
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 6");
    fireEvent.scroll(container);
    await settleScrollSamples();
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 6");
  });
});

// tuxbooks-9pr.6: the spread must behave like one reading surface —
// selection, highlights, search, color, preload, and restore reach book
// mode through the shared position model and the shared render pipeline.
describe("PdfReader book mode parity", () => {
  /** Fakes a settled text selection anchored inside a spread page. */
  async function selectWordsIn(pageElement: HTMLElement, text: string): Promise<void> {
    const anchor = document.createElement("span");
    pageElement.appendChild(anchor);
    // A 512px page box: the client rects below normalize to exact binary
    // fractions (the scroll-view selection tests use the same box).
    pageElement.getBoundingClientRect = () => new DOMRect(0, 0, 512, 512);
    const fakeSelection = {
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: anchor,
      toString: () => text,
      getRangeAt: () => ({
        // One real rect plus one zero-sized rect, which must be dropped.
        getClientRects: () => [new DOMRect(64, 64, 128, 32), new DOMRect(0, 0, 0, 0)],
      }),
      removeAllRanges: vi.fn(),
    };
    vi.spyOn(window, "getSelection").mockReturnValue(fakeSelection as unknown as Selection);
    fireEvent.pointerUp(document);
    // The reader settles the selection one tick after pointerup.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  it("selects text on either page of the spread and creates the highlight on that page", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    const onCreateHighlight = vi.fn();
    const onSelectionChange = vi.fn();
    const adapterRef: { current: ReaderAdapter | null } = { current: null };
    renderBookReader(2, { onCreateHighlight, onSelectionChange, adapterRef });
    fireEvent.click(screen.getByText("book-mode-on"));
    const book = await screen.findByTestId("pdf-book-view");
    stubContentWidth();
    await waitFor(() => expect(book).toHaveAttribute("data-pdf-book-rendered", "2,3"));

    // Every painted spread page carries a selectable text layer over its
    // canvas — the surface a real drag-selection grabs.
    await waitFor(() => {
      expect(document.querySelector('[data-pdf-text-layer="2"]')).not.toBeNull();
      expect(document.querySelector('[data-pdf-text-layer="3"]')).not.toBeNull();
    });

    // Right page of the spread: the settled selection resolves the book
    // page and its rects normalize to that page's box, so the toolbar's
    // create lands the highlight on page 3.
    await selectWordsIn(bookPage(3), "right words");
    expect(onSelectionChange).toHaveBeenLastCalledWith({ text: "right words", highlightId: null });
    adapterRef.current!.annotations.createHighlight("green");
    expect(onCreateHighlight).toHaveBeenCalledWith({
      kind: "highlight",
      pageNumber: 3,
      rects: [{ x: 0.125, y: 0.125, width: 0.25, height: 0.0625 }],
      text: "right words",
      color: "green",
    });

    // The left page of the same spread behaves identically.
    await selectWordsIn(bookPage(2), "left words");
    adapterRef.current!.annotations.createHighlight("yellow");
    expect(onCreateHighlight).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageNumber: 2, text: "left words", color: "yellow" }),
    );
  });

  it("draws persisted highlight overlays on both pages of the spread", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    renderBookReader(2, {
      highlights: [
        makeAnnotation({
          id: 11,
          pageNumber: 2,
          color: "blue",
          rects: [{ x: 0.1, y: 0.2, width: 0.5, height: 0.02 }],
        }),
        makeAnnotation({
          id: 12,
          pageNumber: 3,
          color: "yellow",
          rects: [{ x: 0.2, y: 0.3, width: 0.4, height: 0.02 }],
        }),
      ],
    });
    fireEvent.click(screen.getByText("book-mode-on"));
    const book = await screen.findByTestId("pdf-book-view");
    stubContentWidth();
    await waitFor(() => expect(book).toHaveAttribute("data-pdf-book-rendered", "2,3"));

    // Each spread page draws its own persisted highlights over its canvas,
    // in its own page box.
    expect(bookPage(2).querySelectorAll('[data-pdf-highlight="11"]')).toHaveLength(1);
    expect(bookPage(3).querySelectorAll('[data-pdf-highlight="12"]')).toHaveLength(1);
    expect(bookPage(3).querySelectorAll('[data-pdf-highlight="11"]')).toHaveLength(0);
  });

  it("applies the invert color mode across the whole spread", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    renderBookReader(2, {}, { theme: "invert" });
    fireEvent.click(screen.getByText("book-mode-on"));
    const book = await screen.findByTestId("pdf-book-view");
    stubContentWidth();
    await waitFor(() => expect(book).toHaveAttribute("data-pdf-book-rendered", "2,3"));

    // The invert filter rides the book container, so it covers both pages
    // of the spread — and never the canvas layers themselves (PERF-6).
    expect(book.style.filter).toBe("invert(1) hue-rotate(180deg)");
    expect(book.contains(bookPage(2))).toBe(true);
    expect(book.contains(bookPage(3))).toBe(true);
  });

  it("multiplies the paper tint over the whole spread", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    renderBookReader(2, {}, { theme: "paper" });
    fireEvent.click(screen.getByText("book-mode-on"));
    const book = await screen.findByTestId("pdf-book-view");
    stubContentWidth();
    await waitFor(() => expect(book).toHaveAttribute("data-pdf-book-rendered", "2,3"));

    const tint = within(book).getByTestId("pdf-theme-tint");
    expect(tint.style.backgroundColor).toBe("rgb(246, 240, 228)");
    expect(tint.style.mixBlendMode).toBe("multiply");
  });

  it("rasterizes both spread pages with the Smart dark palette", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    renderBookReader(2, {}, { theme: "dark" });
    fireEvent.click(screen.getByText("book-mode-on"));
    const book = await screen.findByTestId("pdf-book-view");
    stubContentWidth();
    await waitFor(() => expect(book).toHaveAttribute("data-pdf-book-rendered", "2,3"));

    // Both spread pages rasterized with the worker-side palette — the
    // smart render identity, shared with the scroll view's cache — and
    // the page placeholders carry the dark preset, so neither page
    // flashes white before its bitmap blits.
    expect(doc.renderOptions.filter((options) => options.smartColors)).toHaveLength(2);
    expect(bookPage(2).style.backgroundColor).toBe("rgb(16, 16, 19)");
    expect(bookPage(3).style.backgroundColor).toBe("rgb(16, 16, 19)");
  });
});
