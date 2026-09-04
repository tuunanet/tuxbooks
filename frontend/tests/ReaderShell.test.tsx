import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: () => Promise.resolve(() => {}) }),
}));
vi.mock("@/lib/pdf/pdfEngine", () => ({
  openPdfDocument: vi.fn(),
  closePdfDocument: vi.fn(async () => {}),
  getPdfOutline: vi.fn(async () => []),
  pdfWorkerSrc: vi.fn(() => "/assets/pdf.worker.min.mjs"),
  isRenderingCancelled: vi.fn(() => false),
}));
vi.mock("@/lib/epub/epubEngine", async () => {
  const { makeFakeEpubModule } = await import("./mocks/epubEngine");
  return makeFakeEpubModule();
});

import { AppShell } from "@/components/layout/AppShell";
import { getPdfOutline, openPdfDocument } from "@/lib/pdf/pdfEngine";
import { makeBook } from "./factories";
import { scrollTo, stubScrollGeometry } from "./mocks/dom";
import { makeFakePdfDocument } from "./mocks/pdfEngine";
import { lastFakeHandle, fakeEpubHandles } from "./mocks/epubEngine";
import { invokeMock, mockInvoke } from "./mocks/tauri";

beforeEach(() => {
  fakeEpubHandles.length = 0;
});

function renderReader(bookFormat: "epub" | "pdf" = "epub") {
  const book =
    bookFormat === "epub"
      ? makeBook()
      : makeBook({
          id: 1,
          format: "pdf",
          path: "/tmp/library/minimal.pdf",
          title: "A Minimal PDF",
        });
  if (bookFormat === "pdf") {
    vi.mocked(openPdfDocument).mockResolvedValue(
      makeFakePdfDocument(3) as unknown as Awaited<ReturnType<typeof openPdfDocument>>,
    );
  }
  invokeMock.mockClear();
  mockInvoke({
    get_library_stats: { bookCount: 1, collectionCount: 0 },
    list_books: [book],
    get_book_bytes: new ArrayBuffer(16),
    get_reading_progress: null,
    save_reading_progress: null,
  });
  return render(
    <AppShell
      initialState={{
        view: "reader",
        section: { kind: "smart", id: "all-books" },
        selectedBookId: 1,
        libraryQuery: "",
      }}
    />,
  );
}

async function openNavigation() {
  // fireEvent: the tooltip wrapper sets pointer-events:none on hover trails,
  // which user-event refuses to click through.
  fireEvent.click(await screen.findByTestId("reader-nav-trigger"));
  return screen.findByTestId("reader-nav");
}

describe("ReaderShell chrome", () => {
  it("renders the full-window reader without the library sidebar", async () => {
    renderReader();

    const reader = await screen.findByTestId("reader-view");
    expect(reader).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar")).toBeNull();
    expect(screen.getByTestId("reader-title")).toHaveTextContent("A Minimal Book");
    expect(screen.getByTestId("reader-position")).toHaveTextContent("0%");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
  });

  it("returns to the library from the toolbar back button", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    await userEvent.click(screen.getByTestId("reader-back"));

    expect(await screen.findByTestId("library-view")).toBeInTheDocument();
    expect(screen.queryByTestId("reader-view")).not.toBeInTheDocument();
  });

  it("keeps the search affordance honestly disabled", async () => {
    renderReader();

    expect(await screen.findByTestId("reader-view")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search document" })).toBeDisabled();
    // The thumbnails sidebar is a PDF affordance; EPUBs have none.
    expect(screen.queryByTestId("reader-sidebar-toggle")).toBeNull();
  });
});

describe("Reader keyboard navigation", () => {
  it("turns EPUB pages with arrows and space through the engine", async () => {
    renderReader();
    await screen.findByTestId("reader-view");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    const handle = lastFakeHandle();

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(handle.next).toHaveBeenCalledTimes(1);
    // The shell must not percentage-step an EPUB: with no page count that
    // would clamp the position straight to the end of the document.
    expect(screen.getByTestId("reader-position")).toHaveTextContent("0%");
    fireEvent.keyDown(window, { key: " " });
    expect(handle.next).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("reader-position")).toHaveTextContent("0%");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(handle.prev).toHaveBeenCalledTimes(1);

    // The engine-driven position report keeps the footer in sync. Paginated
    // progress moves in chapter steps: section 0 of 2 sits at 0%.
    handle.emitRelocate({ fraction: 0.5, section: { current: 0, total: 2 } });
    await waitFor(() => expect(screen.getByTestId("reader-position")).toHaveTextContent("0%"));

    // In scrolling flow the engine's in-section fraction refines the bar.
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    await screen.findByTestId("appearance-content");
    await userEvent.click(screen.getByRole("radio", { name: "Scrolling" }));
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-layout", "scrolling"),
    );
    // Let the relocate re-subscription effect flush before driving events.
    await new Promise((resolve) => setTimeout(resolve, 50));
    handle.emitRelocate({ fraction: 0.5, section: { current: 0, total: 2 } });
    await waitFor(() => expect(screen.getByTestId("reader-position")).toHaveTextContent("25%"));
  });

  it("steps PDF pages with arrows through the shell", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3"),
    );
  });

  it("jumps EPUB positions with home and end through the engine", async () => {
    renderReader();
    await screen.findByTestId("reader-view");
    const handle = await waitFor(lastFakeHandle);
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    // Jumping needs the engine's section count, reported via relocate.
    handle.emitRelocate({ fraction: 0, section: { current: 0, total: 2 } });

    // End maps onto the last spine section (the fake reports 2 sections).
    fireEvent.keyDown(window, { key: "End" });
    await waitFor(() => expect(handle.goTo).toHaveBeenCalledWith(1));
    // The engine reports its landing position; section 1 of 2 starts at 50%.
    handle.emitRelocate({ fraction: 0, section: { current: 1, total: 2 } });
    await waitFor(() => expect(screen.getByTestId("reader-position")).toHaveTextContent("50%"));

    fireEvent.keyDown(window, { key: "Home" });
    await waitFor(() => expect(handle.goTo).toHaveBeenCalledWith(0));
    expect(screen.getByTestId("reader-position")).toHaveTextContent("0%");
  });
});

describe("Reader bookmarks", () => {
  it("toggles a session bookmark and lists it in the drawer", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.keyDown(window, { key: "End" });
    await waitFor(() => expect(screen.getByTestId("reader-position")).toHaveTextContent("100%"));
    fireEvent.click(screen.getByTestId("reader-bookmark"));
    expect(screen.getByTestId("reader-bookmark")).toHaveAttribute("aria-pressed", "true");

    await openNavigation();
    await userEvent.click(await screen.findByTestId("nav-tab-bookmarks"));
    expect(await screen.findByTestId("nav-bookmark-100")).toBeInTheDocument();
    expect(screen.getByText(/session only/i)).toBeInTheDocument();

    // Close the drawer before interacting with the toolbar underneath it.
    await userEvent.keyboard("{Escape}");
    fireEvent.click(screen.getByTestId("reader-bookmark"));
    expect(screen.getByTestId("reader-bookmark")).toHaveAttribute("aria-pressed", "false");

    await openNavigation();
    await userEvent.click(screen.getByTestId("nav-tab-bookmarks"));
    expect(await screen.findByTestId("nav-bookmarks-empty")).toBeInTheDocument();
  });
});

describe("ReaderNavigation", () => {
  it("lists the engine's EPUB contents and jumps through the engine", async () => {
    renderReader();

    await openNavigation();
    expect(await screen.findByTestId("toc-item-0")).toHaveTextContent("Chapter One");
    expect(screen.getByTestId("toc-item-1")).toHaveTextContent("Chapter Two");

    await userEvent.click(screen.getByTestId("toc-item-1"));
    expect(lastFakeHandle().goTo).toHaveBeenCalledWith("chapter2.xhtml");
    expect(screen.queryByTestId("reader-nav")).not.toBeInTheDocument();
    // Contents come from the rendering engine, not a backend command.
    expect(invokeMock).not.toHaveBeenCalledWith("get_book_toc", { bookId: 1 });
  });

  it("shows a loading state while the EPUB document is still opening", async () => {
    const book = makeBook();
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [book],
      get_book_bytes: new Promise(() => {}),
      get_reading_progress: null,
      save_reading_progress: null,
    });
    render(
      <AppShell
        initialState={{
          view: "reader",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
        }}
      />,
    );
    await screen.findByTestId("reader-view");

    await openNavigation();
    expect(await screen.findByText("Loading contents…")).toBeInTheDocument();
  });

  it("gives PDFs Pages and a real outline that jumps to pages", async () => {
    vi.mocked(getPdfOutline).mockResolvedValueOnce([
      { title: "Chapter One", page: 1, items: [] },
      {
        title: "Part Two",
        page: 2,
        items: [{ title: "Section Two-A", page: 3, items: [] }],
      },
    ]);
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    await openNavigation();
    expect(await screen.findByTestId("nav-pages")).toBeInTheDocument();
    expect(screen.getByTestId("nav-page-3")).toBeInTheDocument();
    expect(invokeMock).toHaveBeenCalledWith("get_book_bytes", { bookId: 1 });

    await userEvent.click(screen.getByTestId("nav-page-2"));
    expect(await screen.findByTestId("reader-position")).toHaveTextContent("50%");

    // Re-open for the Outline tab (Radix unmounts inactive tab content).
    await openNavigation();
    await userEvent.click(await screen.findByTestId("nav-tab-outline"));
    // Hierarchical entries flatten with depth; leaf navigation jumps pages.
    expect(await screen.findByTestId("nav-outline-item-0")).toHaveTextContent("Chapter One");
    expect(screen.getByTestId("nav-outline-item-1")).toHaveTextContent("Part Two");
    expect(screen.getByTestId("nav-outline-item-2")).toHaveTextContent("Section Two-A");

    await userEvent.click(screen.getByTestId("nav-outline-item-2"));
    await waitFor(() => expect(screen.getByTestId("reader-position")).toHaveTextContent("100%"));
    expect(screen.queryByTestId("reader-nav")).not.toBeInTheDocument();
  });

  it("shows an empty outline state for documents without one", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    await openNavigation();
    await userEvent.click(await screen.findByTestId("nav-tab-outline"));
    expect(await screen.findByTestId("nav-outline-empty")).toHaveTextContent(/no outline/i);
  });

  it("toggles the thumbnails sidebar and navigates from it", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    const toggle = screen.getByTestId("reader-sidebar-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByTestId("pdf-sidebar")).toBeNull();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    const sidebar = await screen.findByTestId("pdf-sidebar");
    // Whole document reserved; the current page paints and is marked.
    expect(sidebar.querySelectorAll("[data-pdf-thumb-slot]")).toHaveLength(3);
    await waitFor(() =>
      expect(sidebar.querySelector('[data-pdf-thumb-slot="1"]')).toHaveAttribute(
        "data-thumb-state",
        "rendered",
      ),
    );
    await userEvent.click(
      sidebar.querySelector('[data-pdf-thumb-slot="3"] button') as HTMLButtonElement,
    );
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 3"),
    );

    fireEvent.click(toggle);
    expect(screen.queryByTestId("pdf-sidebar")).toBeNull();
  });

  it("shows the pdf page counter following the reading position", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    fireEvent.keyDown(window, { key: "End" });
    expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 3");
  });

  it("tracks the current page from scrolling the reading surface", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    const container = screen.getByTestId("reader-content");
    const documentEl = document.querySelector("[data-testid=pdf-document]");
    expect(documentEl).not.toBeNull();
    stubScrollGeometry(container as HTMLElement, documentEl as HTMLElement);

    scrollTo(container as HTMLElement, 810);
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );

    scrollTo(container as HTMLElement, 1620);
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 3"),
    );

    // The reader must not scroll back over its own scroll-driven update.
    scrollTo(container as HTMLElement, 0);
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 1 of 3"),
    );
  });

  it("scrolls the reading surface with PageUp and PageDown", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    const container = screen.getByTestId("reader-content") as HTMLElement;
    Object.defineProperty(container, "clientHeight", { value: 720, configurable: true });

    fireEvent.keyDown(window, { key: "PageDown" });
    expect(container.scrollTop).toBe(648);
    fireEvent.keyDown(window, { key: "PageDown" });
    expect(container.scrollTop).toBe(1296);

    fireEvent.keyDown(window, { key: "PageUp" });
    expect(container.scrollTop).toBe(648);
  });
});

describe("ReaderAppearance", () => {
  it("changes the reader theme, layout, and font family", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    const content = await screen.findByTestId("appearance-content");
    expect(content).toBeInTheDocument();

    // Radix toggle groups inside the popover render radio semantics.
    await userEvent.click(screen.getByRole("radio", { name: "Paper" }));
    expect(screen.getByTestId("reader-view")).toHaveAttribute("data-theme", "paper");

    await userEvent.click(screen.getByRole("radio", { name: "Scrolling" }));
    expect(await screen.findByTestId("epub-reader")).toHaveAttribute("data-layout", "scrolling");
    const handle = lastFakeHandle();
    await waitFor(() => expect(handle.setFlow).toHaveBeenCalledWith("scrolled"));

    await userEvent.click(screen.getByRole("radio", { name: "Serif" }));
    await waitFor(() => expect(handle.setAppearance).toHaveBeenCalledWith("css:paper:17:1.6"));
  });

  it("exposes font size and line spacing sliders", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    const content = await screen.findByTestId("appearance-content");

    expect(content).toHaveTextContent("Font size");
    expect(content).toHaveTextContent("17px");
    expect(content).toHaveTextContent("Line spacing");
    expect(content).toHaveTextContent("1.6");
    expect(screen.getByLabelText("Font size")).toBeInTheDocument();
    expect(screen.getByLabelText("Line spacing")).toBeInTheDocument();
  });
});

describe("Reader book switching", () => {
  it("gives a switched book a fresh reader and its own navigation data", async () => {
    const epub = makeBook();
    const pdf = makeBook({
      id: 2,
      format: "pdf",
      path: "/tmp/library/minimal.pdf",
      title: "A Minimal PDF",
    });
    vi.mocked(getPdfOutline).mockResolvedValue([{ title: "Part One", page: 1, items: [] }]);
    vi.mocked(openPdfDocument).mockResolvedValue(
      makeFakePdfDocument(3) as unknown as Awaited<ReturnType<typeof openPdfDocument>>,
    );
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [epub, pdf],
      get_book_bytes: new ArrayBuffer(16),
      get_reading_progress: null,
      save_reading_progress: null,
    });
    render(
      <AppShell
        initialState={{
          view: "reader",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
        }}
      />,
    );

    // The EPUB session lists its engine TOC in the drawer.
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    await openNavigation();
    expect(await screen.findByTestId("toc-item-0")).toHaveTextContent("Chapter One");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("reader-nav")).not.toBeInTheDocument());

    // Back to the library, then open the PDF through the normal flow.
    await userEvent.click(screen.getByTestId("reader-back"));
    await screen.findByTestId("library-view");
    fireEvent.doubleClick(await screen.findByLabelText("A Minimal PDF (PDF)"));
    await screen.findByTestId("book-detail");
    await userEvent.click(screen.getByTestId("detail-continue"));

    // The remounted reader starts clean: EPUB chrome is gone, position is
    // fresh, and the drawer shows the PDF's outline — never the previous
    // book's table of contents (the shell's bookId-tagged state guard).
    await screen.findByTestId("pdf-canvas");
    expect(screen.queryByTestId("epub-reader")).not.toBeInTheDocument();
    expect(screen.getByTestId("reader-position")).toHaveTextContent("0%");
    await openNavigation();
    await userEvent.click(await screen.findByTestId("nav-tab-outline"));
    expect(await screen.findByTestId("nav-outline-item-0")).toHaveTextContent("Part One");
    expect(screen.queryByTestId("toc-item-0")).not.toBeInTheDocument();

    // The switch closed the EPUB engine and opened no new one (the PDF has
    // no engine handles): the old engine died with its reader unmount.
    expect(fakeEpubHandles).toHaveLength(1);
    expect(fakeEpubHandles[0]!.close).toHaveBeenCalledTimes(1);
    expect(fakeEpubHandles[0]!.host.isConnected).toBe(false);
  });
});
