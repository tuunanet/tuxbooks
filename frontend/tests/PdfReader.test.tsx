import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/pdf/pdfEngine", () => ({
  openPdfDocument: vi.fn(),
  closePdfDocument: vi.fn(async () => {}),
  RenderingCancelledException: class RenderingCancelledException extends Error {},
}));

import { PdfReader } from "@/components/reader/pdf/PdfReader";
import { closePdfDocument, openPdfDocument } from "@/lib/pdf/pdfEngine";
import { ReaderProvider } from "@/state/ReaderProvider";
import { makeBook } from "./factories";
import { invokeMock, mockInvoke } from "./mocks/tauri";
import { makeFakePdfDocument } from "./mocks/pdfEngine";

const openDocumentMock = vi.mocked(openPdfDocument);
const closeDocumentMock = vi.mocked(closePdfDocument);

type EngineDocument = Awaited<ReturnType<typeof openPdfDocument>>;

const pdfBook = makeBook({
  id: 7,
  format: "pdf",
  path: "/tmp/library/minimal.pdf",
  title: "A Minimal PDF",
});

function renderPdfReader(props: { onDocumentLoad?: (count: number) => void } = {}) {
  return render(
    <ReaderProvider>
      <PdfReader book={pdfBook} onDocumentLoad={props.onDocumentLoad} />
    </ReaderProvider>,
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
    mockInvoke({ get_book_bytes: new ArrayBuffer(16) });

    await renderLoadedReader();

    expect(invokeMock).toHaveBeenCalledWith("get_book_bytes", { bookId: 7 });
    expect(openDocumentMock).toHaveBeenCalledTimes(1);
    const [firstCall] = openDocumentMock.mock.calls;
    expect(firstCall?.[0]).toBeInstanceOf(Uint8Array);
    expect(doc.getPage).toHaveBeenCalledWith(1);
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3");

    const canvas = screen.getByTestId("pdf-canvas");
    expect(canvas).toHaveAttribute("width", "612");
    expect(canvas).toHaveAttribute("height", "792");
    expect(canvas).toHaveAttribute("data-pdf-page", "1");
    await waitFor(() => expect(slot(1)).toHaveAttribute("data-render-state", "rendered"));
    // Scale-1 viewport calls, in order: geometry reference (page 1), page-1
    // render, then the measurement window around the active page (page 2).
    expect(doc.scales).toEqual([1, 1, 1]);
  });

  it("shows the loading state until the document and layout are ready", async () => {
    let resolveDocument: (value: EngineDocument) => void = () => {};
    openDocumentMock.mockReturnValue(
      new Promise((resolve) => {
        resolveDocument = resolve as (value: EngineDocument) => void;
      }) as never,
    );
    mockInvoke({ get_book_bytes: new ArrayBuffer(16) });

    renderPdfReader();
    expect(await screen.findByTestId("pdf-loading")).toHaveTextContent("Loading A Minimal PDF…");
    expect(screen.queryByTestId("pdf-canvas")).not.toBeInTheDocument();

    resolveDocument(makeFakePdfDocument(3) as unknown as EngineDocument);
    expect(await screen.findByTestId("pdf-canvas")).toBeInTheDocument();
  });

  it("renders one slot per page with the loading slot marked", async () => {
    const doc = makeFakePdfDocument(100);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({ get_book_bytes: new ArrayBuffer(16) });

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
    mockInvoke({ get_book_bytes: new ArrayBuffer(16) });

    await renderLoadedReader();

    // The measurement window around the active page corrects page 2's
    // estimate (612x792) to its real size; siblings keep theirs. The
    // transient estimate state is a render race under jsdom and is covered
    // by pdfLayout.test.ts instead of asserted here.
    await waitFor(() => expect(slot(2)).toHaveStyle({ width: "792px", height: "612px" }));
    expect(slot(1)).toHaveStyle({ width: "612px", height: "792px" });
    expect(slot(3)).toHaveStyle({ width: "612px", height: "792px" });
    expect(slot(2)?.style.marginTop).toBe("8px");
  });

  it("reports the loaded page count to the shell", async () => {
    openDocumentMock.mockResolvedValue(makeFakePdfDocument(3) as unknown as EngineDocument);
    mockInvoke({ get_book_bytes: new ArrayBuffer(16) });

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
    mockInvoke({ get_book_bytes: new ArrayBuffer(16) });

    const view = await renderLoadedReader();
    view.unmount();

    expect(closeDocumentMock).toHaveBeenCalledWith(doc);
  });
});

describe("PdfReader navigation", () => {
  it("navigates with prev/next and disables at both bounds", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({ get_book_bytes: new ArrayBuffer(16) });

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
    mockInvoke({ get_book_bytes: new ArrayBuffer(16) });
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

  it("steps through fixed zoom levels and re-renders the viewport", async () => {
    const doc = makeFakePdfDocument(3);
    openDocumentMock.mockResolvedValue(doc as unknown as EngineDocument);
    mockInvoke({ get_book_bytes: new ArrayBuffer(16) });

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
