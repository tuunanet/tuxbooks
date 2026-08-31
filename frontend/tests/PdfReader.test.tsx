import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/lib/pdf/pdfEngine", () => ({
  openPdfDocument: vi.fn(),
  closePdfDocument: vi.fn(async () => {}),
  RenderingCancelledException: class RenderingCancelledException extends Error {},
}));

import { PdfReader } from "@/components/reader/PdfReader";
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
    expect(doc.scales).toEqual([1]);
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3");

    const canvas = screen.getByTestId("pdf-canvas");
    expect(canvas).toHaveAttribute("width", "612");
    expect(canvas).toHaveAttribute("height", "792");
    expect(canvas).toHaveAttribute("data-page", "1");
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
    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-page", "2"));
    expect(doc.getPage).toHaveBeenCalledWith(2);
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3");

    await userEvent.click(next);
    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-page", "3"));
    expect(next).toBeDisabled();

    await userEvent.click(prev);
    await waitFor(() => expect(screen.getByTestId("pdf-canvas")).toHaveAttribute("data-page", "2"));
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3");
  });
});

describe("PdfReader zoom", () => {
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
