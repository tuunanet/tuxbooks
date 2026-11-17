import { describe, expect, it, vi, beforeEach, afterEach } from "vite-plus/test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Annotation } from "@/types/domain";
import type { AppState } from "@/state/appState";

vi.mock("@/lib/pdf/pdfEngine", async () => {
  const { findPageMatches } = await import("@/lib/pdf/pdfSearch");
  return {
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
vi.mock("@/lib/epub/readiumEngine", async () => {
  const { makeFakeReadiumModule } = await import("./mocks/readiumEngine");
  return makeFakeReadiumModule();
});

import { AppShell } from "@/components/layout/AppShell";
import { ReaderNavigation } from "@/components/reader/ReaderNavigation";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getPdfOutline, openPdfDocumentFromBook } from "@/lib/pdf/pdfEngine";
import { READER_SETTINGS_STORAGE_KEY } from "@/lib/readerSettings";
import { THEME_STORAGE_KEY } from "@/lib/theme";
import { DEFAULT_READER_PREFERENCES } from "@/state/readerState";
import { ThemeStateProvider } from "@/state/ThemeStateProvider";
import { makeAnnotation, makeBook } from "./factories";
import { makeDomRect, scrollTo, stubScrollGeometry } from "./mocks/dom";
import { makeFakePdfDocument } from "./mocks/pdfEngine";
import { lastFakeHandle, fakeEpubHandles, FAKE_LOCATOR } from "./mocks/readiumEngine";
import { invokeMock, mockInvoke } from "./mocks/bridge";

beforeEach(() => {
  fakeEpubHandles.length = 0;
});

function renderReader(
  bookFormat: "epub" | "pdf" = "epub",
  {
    annotations = [],
    state = {},
    pdfPageCount = 3,
  }: {
    annotations?: Annotation[];
    state?: Partial<AppState>;
    pdfPageCount?: number;
  } = {},
) {
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
    vi.mocked(openPdfDocumentFromBook).mockResolvedValue(
      makeFakePdfDocument(pdfPageCount) as unknown as Awaited<
        ReturnType<typeof openPdfDocumentFromBook>
      >,
    );
  }
  invokeMock.mockClear();
  mockInvoke({
    get_library_stats: { bookCount: 1, collectionCount: 0 },
    list_books: [book],
    get_reading_progress: null,
    save_reading_progress: null,
    mark_book_opened: null,
    list_annotations: annotations,
    create_annotation: makeAnnotation({
      id: 1,
      kind: "bookmark",
      cfi: FAKE_LOCATOR.section2,
      chapterHref: "chapter1.xhtml",
      pageNumber: null,
      rects: null,
      text: null,
    }),
    update_annotation: null,
    delete_annotation: true,
  });
  return render(
    // jsdom's matchMedia stub reports light, so the surface stays on publisher default.
    <ThemeStateProvider>
      <AppShell
        initialState={{
          view: "reader",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
          ...state,
        }}
      />
    </ThemeStateProvider>,
  );
}

async function openNavigation() {
  // fireEvent: user-event refuses clicks through the tooltip wrapper's pointer-events:none.
  fireEvent.click(await screen.findByTestId("reader-nav-trigger"));
  return screen.findByTestId("reader-nav");
}

/**
 * Pin the progress bar's jsdom geometry (a 1000px span, so clientX 510
 * reads as 51%) and give it a working pointer-capture pair: the test setup
 * stubs capture out globally, and Radix commits on release only through it.
 */
function stubProgressBar(bar: HTMLElement) {
  vi.spyOn(bar, "getBoundingClientRect").mockReturnValue({
    ...makeDomRect(400),
    height: 4,
    bottom: 404,
  });
  let capturedPointerId: number | null = null;
  vi.spyOn(bar, "hasPointerCapture").mockImplementation((id) => capturedPointerId === id);
  vi.spyOn(bar, "setPointerCapture").mockImplementation((id) => {
    capturedPointerId = id;
  });
  vi.spyOn(bar, "releasePointerCapture").mockImplementation((id) => {
    if (capturedPointerId === id) capturedPointerId = null;
  });
}

describe("Reader progress footer", () => {
  it("shows no progress footer for PDF", async () => {
    renderReader("pdf");
    await screen.findByTestId("reader-view");

    expect(screen.queryByTestId("reader-footer")).toBeNull();
    expect(screen.queryByTestId("reader-footer-hover-zone")).toBeNull();
    expect(screen.queryByTestId("reader-progress")).toBeNull();
  });

  it("keeps the EPUB footer always visible without a hover zone", async () => {
    renderReader();
    await screen.findByTestId("reader-view");

    expect(screen.getByTestId("reader-footer")).toHaveAttribute("data-progress-visible", "true");
    expect(screen.queryByTestId("reader-footer-hover-zone")).toBeNull();
  });

  it("teleports the EPUB reading position to a clicked bar fraction", async () => {
    renderReader();
    await screen.findByTestId("reader-view");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    const bar = screen.getByTestId("reader-progress");
    stubProgressBar(bar);
    fireEvent.pointerDown(bar, { button: 0, clientX: 510, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerUp(bar, { button: 0, clientX: 510, pointerId: 1, pointerType: "mouse" });

    await waitFor(() => expect(lastFakeHandle().goToTotalProgression).toHaveBeenCalledWith(0.51));
  });

  it("commits one engine jump per dragging gesture, on release", async () => {
    renderReader();
    await screen.findByTestId("reader-view");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    const bar = screen.getByTestId("reader-progress");
    stubProgressBar(bar);

    fireEvent.pointerDown(bar, { button: 0, clientX: 100, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerMove(bar, { clientX: 300, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerMove(bar, { clientX: 700, pointerId: 1, pointerType: "mouse" });
    const handle = lastFakeHandle();
    expect(handle.goToTotalProgression).not.toHaveBeenCalled();
    fireEvent.pointerUp(bar, { button: 0, clientX: 700, pointerId: 1, pointerType: "mouse" });

    await waitFor(() => expect(handle.goToTotalProgression).toHaveBeenCalledTimes(1));
    expect(handle.goToTotalProgression).toHaveBeenCalledWith(0.7);
    await waitFor(() => expect(screen.getByTestId("reader-position")).toHaveTextContent("70%"));
  });

  it("steps and jumps the bar from the keyboard through the engine", async () => {
    renderReader();
    await screen.findByTestId("reader-view");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    const thumb = screen.getByRole("slider", { name: "Reading position" });
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    await waitFor(() =>
      expect(lastFakeHandle().goToTotalProgression).toHaveBeenLastCalledWith(
        expect.closeTo(0.001, 12),
      ),
    );
    fireEvent.keyDown(thumb, { key: "End" });
    await waitFor(() => expect(lastFakeHandle().goToTotalProgression).toHaveBeenLastCalledWith(1));
    fireEvent.keyDown(thumb, { key: "Home" });
    await waitFor(() => expect(lastFakeHandle().goToTotalProgression).toHaveBeenLastCalledWith(0));
  });

  it("turns pages for thumb arrow steps after a bar click jump", async () => {
    renderReader();
    await screen.findByTestId("reader-view");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    const bar = screen.getByTestId("reader-progress");
    stubProgressBar(bar);
    fireEvent.pointerDown(bar, { button: 0, clientX: 510, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerUp(bar, { button: 0, clientX: 510, pointerId: 1, pointerType: "mouse" });
    await waitFor(() => expect(lastFakeHandle().goToTotalProgression).toHaveBeenCalledWith(0.51));

    lastFakeHandle().emitRelocate({ fraction: 0.51, totalProgression: 0.51 });
    await waitFor(() => expect(screen.getByTestId("reader-position")).toHaveTextContent("51%"));

    const thumb = screen.getByRole("slider", { name: "Reading position" });
    thumb.focus();
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    await waitFor(() =>
      expect(lastFakeHandle().goToTotalProgression).toHaveBeenLastCalledWith(
        expect.closeTo(0.511, 3),
      ),
    );

    lastFakeHandle().emitRelocate({ fraction: 0.511, totalProgression: 0.511 });
    fireEvent.keyDown(thumb, { key: "ArrowLeft" });
    await waitFor(() =>
      expect(lastFakeHandle().goToTotalProgression).toHaveBeenLastCalledWith(
        expect.closeTo(0.51, 3),
      ),
    );
  });

  it("hands keyboard reading back to the surface after a bar click seek", async () => {
    renderReader();
    await screen.findByTestId("reader-view");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    const bar = screen.getByTestId("reader-progress");
    stubProgressBar(bar);
    fireEvent.pointerDown(bar, { button: 0, clientX: 510, pointerId: 1, pointerType: "mouse" });
    const thumb = screen.getByRole("slider", { name: "Reading position" });
    thumb.focus();
    fireEvent.pointerUp(bar, { button: 0, clientX: 510, pointerId: 1, pointerType: "mouse" });

    expect(thumb).not.toHaveFocus();

    const handle = lastFakeHandle();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(handle.next).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: " " });
    expect(handle.next).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(handle.prev).toHaveBeenCalledTimes(1);
  });

  it("keeps the positioning label live under a resting pointer", async () => {
    renderReader();
    await screen.findByTestId("reader-view");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    const bar = screen.getByTestId("reader-progress");
    stubProgressBar(bar);

    fireEvent.pointerDown(bar, { button: 0, clientX: 255, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerUp(bar, { button: 0, clientX: 255, pointerId: 1, pointerType: "mouse" });
    expect(screen.getByTestId("reader-progress-tooltip")).toHaveTextContent(
      /Location 1508 of 5913 • 26%/,
    );

    lastFakeHandle().emitRelocate({ fraction: 0.76, totalProgression: 0.76 });
    await waitFor(() =>
      expect(screen.getByTestId("reader-progress-tooltip")).toHaveTextContent(
        /Location 4494 of 5913 • 76%/,
      ),
    );

    fireEvent.pointerLeave(bar);
    await waitFor(() => expect(screen.queryByTestId("reader-progress-tooltip")).toBeNull());
  });

  it("shows a Kindle-style location tooltip while positioning", async () => {
    renderReader();
    await screen.findByTestId("reader-view");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    const bar = screen.getByTestId("reader-progress");
    stubProgressBar(bar);

    expect(screen.queryByTestId("reader-progress-tooltip")).toBeNull();

    fireEvent.pointerDown(bar, { button: 0, clientX: 255, pointerId: 1, pointerType: "mouse" });
    const tooltip = screen.queryByTestId("reader-progress-tooltip");
    expect(tooltip).not.toBeNull();
    expect(tooltip).toHaveTextContent(/Location \d+ of \d+ • 26%/);

    fireEvent.pointerUp(bar, { button: 0, clientX: 255, pointerId: 1, pointerType: "mouse" });
    fireEvent.pointerLeave(bar, { button: 0, clientX: 255, pointerId: 1, pointerType: "mouse" });
    await waitFor(() => expect(screen.queryByTestId("reader-progress-tooltip")).toBeNull());
  });
});

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

  it("opens settings from the toolbar without leaving the reader", async () => {
    renderReader();
    await screen.findByTestId("reader-view");

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(await screen.findByTestId("settings-window")).toBeInTheDocument();
    expect(screen.getByTestId("reader-view")).toBeInTheDocument();
  });

  it("stamps last opened once when a reading session starts", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("mark_book_opened", { bookId: 1 }));
    expect(invokeMock.mock.calls.filter(([method]) => method === "mark_book_opened")).toHaveLength(
      1,
    );
  });

  it("opens the in-book search overlay from the toolbar", async () => {
    renderReader();

    expect(await screen.findByTestId("reader-view")).toBeInTheDocument();
    const searchButton = screen.getByRole("button", { name: "Search in book" });
    expect(searchButton).toBeEnabled();
    expect(screen.queryByTestId("reader-sidebar-toggle")).toBeNull();

    await userEvent.click(searchButton);
    expect(await screen.findByTestId("reader-search-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("reader-search-input")).toBeInTheDocument();
    expect(screen.queryByTestId("reader-nav")).toBeNull();
  });

  it("toggles the search overlay with Ctrl+F", async () => {
    renderReader();
    await screen.findByTestId("reader-view");

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(await screen.findByTestId("reader-search-overlay")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    await waitFor(() => expect(screen.queryByTestId("reader-search-overlay")).toBeNull());

    fireEvent.keyDown(window, { key: "f", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.queryByTestId("reader-search-overlay")).toBeNull());

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    expect(await screen.findByTestId("reader-search-overlay")).toBeInTheDocument();
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
    expect(screen.getByTestId("reader-position")).toHaveTextContent("0%");
    fireEvent.keyDown(window, { key: " " });
    expect(handle.next).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("reader-position")).toHaveTextContent("0%");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(handle.prev).toHaveBeenCalledTimes(1);

    handle.emitRelocate({
      fraction: 0.5,
      section: { current: 0, total: 2 },
      totalProgression: 0.1,
    });
    await waitFor(() => expect(screen.getByTestId("reader-position")).toHaveTextContent("10%"));

    fireEvent.click(screen.getByTestId("appearance-trigger"));
    await screen.findByTestId("appearance-content");
    await userEvent.click(screen.getByRole("radio", { name: "Scrolling" }));
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-layout", "scrolling"),
    );
    // Let the relocate re-subscription effect flush before driving events.
    await new Promise((resolve) => setTimeout(resolve, 50));
    handle.emitRelocate({
      fraction: 0.5,
      section: { current: 0, total: 2 },
      totalProgression: 0.25,
    });
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

    fireEvent.keyDown(window, { key: "End" });
    await waitFor(() => expect(handle.goToTotalProgression).toHaveBeenCalledWith(1));
    handle.emitRelocate({ fraction: 1, section: { current: 1, total: 2 }, totalProgression: 1 });
    await waitFor(() => expect(screen.getByTestId("reader-position")).toHaveTextContent("100%"));

    fireEvent.keyDown(window, { key: "Home" });
    await waitFor(() => expect(handle.goToTotalProgression).toHaveBeenCalledWith(0));
    handle.emitRelocate({ fraction: 0, section: { current: 0, total: 2 }, totalProgression: 0 });
    await waitFor(() => expect(screen.getByTestId("reader-position")).toHaveTextContent("0%"));
  });
});

describe("Reader keyboard navigation in PDF book mode", () => {
  /** Waits until the book view has mounted and registered its adapter. */
  async function enterBookMode(pageCount: number) {
    renderReader("pdf", { pdfPageCount: pageCount });
    await screen.findByTestId("pdf-canvas");
    fireEvent.click(screen.getByTestId("reader-book-mode"));
    await screen.findByTestId("pdf-book-view");
  }

  const indicator = () => screen.getByTestId("pdf-page-indicator");

  it("steps by spread with arrows, space, and the page keys", async () => {
    await enterBookMode(6);
    await waitFor(() => expect(indicator()).toHaveTextContent("Page 1 of 6"));

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(indicator()).toHaveTextContent("Page 2 of 6"));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(indicator()).toHaveTextContent("Page 4 of 6"));
    fireEvent.keyDown(window, { key: " " });
    await waitFor(() => expect(indicator()).toHaveTextContent("Page 6 of 6"));
    fireEvent.keyDown(window, { key: " " });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(indicator()).toHaveTextContent("Page 6 of 6");
    fireEvent.keyDown(window, { key: " ", shiftKey: true });
    await waitFor(() => expect(indicator()).toHaveTextContent("Page 5 of 6"));
    fireEvent.keyDown(window, { key: "PageDown" });
    await waitFor(() => expect(indicator()).toHaveTextContent("Page 6 of 6"));
    fireEvent.keyDown(window, { key: "PageUp" });
    await waitFor(() => expect(indicator()).toHaveTextContent("Page 5 of 6"));
  });

  it("steps by spread with the toolbar page buttons", async () => {
    await enterBookMode(6);
    await waitFor(() => expect(indicator()).toHaveTextContent("Page 1 of 6"));

    fireEvent.click(screen.getByTestId("pdf-next"));
    await waitFor(() => expect(indicator()).toHaveTextContent("Page 2 of 6"));
    fireEvent.click(screen.getByTestId("pdf-next"));
    await waitFor(() => expect(indicator()).toHaveTextContent("Page 4 of 6"));
    fireEvent.click(screen.getByTestId("pdf-prev"));
    await waitFor(() => expect(indicator()).toHaveTextContent("Page 3 of 6"));
  });

  it("turns one spread per Space press with a turn zone focused", async () => {
    await enterBookMode(6);
    await waitFor(() => expect(indicator()).toHaveTextContent("Page 1 of 6"));

    const nextZone = document.querySelector<HTMLElement>('[data-pdf-book-turn-edge="next"]');
    if (!nextZone) throw new Error("no next turn zone");
    nextZone.focus();
    // The zone's own activation is the one turn; the global Space shortcut must not fire on keydown.
    await userEvent.keyboard(" ");
    await waitFor(() => expect(indicator()).toHaveTextContent("Page 2 of 6"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(indicator()).toHaveTextContent("Page 2 of 6");
  });

  it("keeps presentation mode's one-page turns over book mode", async () => {
    await enterBookMode(6);

    fireEvent.keyDown(window, { key: "l", ctrlKey: true });
    expect(screen.getByTestId("reader-view")).toHaveAttribute("data-pdf-presentation", "true");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(indicator()).toHaveTextContent("Page 2 of 6"));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(indicator()).toHaveTextContent("Page 3 of 6"));
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() => expect(indicator()).toHaveTextContent("Page 2 of 6"));
  });
});

describe("Reader bookmarks", () => {
  it("creates a persistent bookmark at the engine locator and removes it on toggle", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    lastFakeHandle().emitRelocate({ locator: FAKE_LOCATOR.section2 });
    await waitFor(() => expect(screen.getByTestId("reader-position")).toHaveTextContent("0%"));

    fireEvent.click(screen.getByTestId("reader-bookmark"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("create_annotation", {
        bookId: 1,
        annotation: {
          kind: "bookmark",
          cfi: FAKE_LOCATOR.section2,
          chapterHref: "chapter1.xhtml",
        },
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("reader-bookmark")).toHaveAttribute("aria-pressed", "true"),
    );

    await openNavigation();
    await userEvent.click(await screen.findByTestId("nav-tab-bookmarks"));
    expect(await screen.findByTestId("nav-bookmark-0")).toBeInTheDocument();
    expect(screen.queryByText(/session only/i)).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    fireEvent.click(screen.getByTestId("reader-bookmark"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("delete_annotation", { id: 1 }));
    await waitFor(() =>
      expect(screen.getByTestId("reader-bookmark")).toHaveAttribute("aria-pressed", "false"),
    );
  });

  it("lists stored bookmarks and highlights on open and deletes from the drawer", async () => {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      get_reading_progress: null,
      save_reading_progress: null,
      list_annotations: [
        makeAnnotation({ id: 7, kind: "highlight", text: "the quoted words" }),
        makeAnnotation({
          id: 9,
          kind: "bookmark",
          cfi: "epubcfi(/6/2!/4/2)",
          chapterHref: "chapter1.xhtml",
          pageNumber: null,
          rects: null,
          text: null,
        }),
      ],
      create_annotation: makeAnnotation(),
      update_annotation: null,
      delete_annotation: true,
    });
    render(
      <ThemeStateProvider>
        <AppShell
          initialState={{
            view: "reader",
            section: { kind: "smart", id: "all-books" },
            selectedBookId: 1,
            libraryQuery: "",
          }}
        />
      </ThemeStateProvider>,
    );
    await screen.findByTestId("reader-view");

    await openNavigation();
    await userEvent.click(await screen.findByTestId("nav-tab-bookmarks"));
    expect(await screen.findByTestId("nav-bookmark-0")).toHaveTextContent("Chapter One");

    await userEvent.click(screen.getByTestId("nav-tab-highlights"));
    const row = await screen.findByTestId("nav-highlight-0");
    expect(row).toHaveTextContent("the quoted words");
    expect(screen.getByTestId("nav-highlight-color-0")).toHaveStyle({
      background: "rgba(255, 189, 26, 0.42)",
    });

    await userEvent.click(screen.getByTestId("nav-highlight-delete-0"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("delete_annotation", { id: 7 }));
  });

  it("attaches a note to a highlight through the drawer", async () => {
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      get_reading_progress: null,
      save_reading_progress: null,
      list_annotations: [makeAnnotation({ id: 5 })],
      create_annotation: makeAnnotation(),
      update_annotation: makeAnnotation({ id: 5, note: "remember this" }),
      delete_annotation: true,
    });
    render(
      <ThemeStateProvider>
        <AppShell
          initialState={{
            view: "reader",
            section: { kind: "smart", id: "all-books" },
            selectedBookId: 1,
            libraryQuery: "",
          }}
        />
      </ThemeStateProvider>,
    );
    await screen.findByTestId("reader-view");

    await openNavigation();
    await userEvent.click(await screen.findByTestId("nav-tab-highlights"));
    await screen.findByTestId("nav-highlight-0");
    await userEvent.click(screen.getByTestId("nav-highlight-note-0"));

    const input = screen.getByTestId("annotation-note-input");
    await userEvent.type(input, "remember this");
    await userEvent.click(screen.getByTestId("annotation-note-save"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_annotation", {
        id: 5,
        patch: { note: "remember this" },
      }),
    );
  });

  it("labels a bookmark and shows its chapter progress in the drawer", async () => {
    invokeMock.mockClear();
    const bookmark = makeAnnotation({
      id: 9,
      kind: "bookmark",
      cfi: '{"href":"chapter1.xhtml","locations":{"progression":0.4}}',
      chapterHref: "chapter1.xhtml",
      pageNumber: null,
      text: null,
      rects: null,
    });
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      get_reading_progress: null,
      save_reading_progress: null,
      list_annotations: [bookmark],
      update_annotation: makeAnnotation({ ...bookmark, label: "Opening scene" }),
      delete_annotation: true,
    });
    render(
      <ThemeStateProvider>
        <AppShell
          initialState={{
            view: "reader",
            section: { kind: "smart", id: "all-books" },
            selectedBookId: 1,
            libraryQuery: "",
          }}
        />
      </ThemeStateProvider>,
    );
    await screen.findByTestId("reader-view");

    await openNavigation();
    await userEvent.click(await screen.findByTestId("nav-tab-bookmarks"));
    expect(await screen.findByTestId("nav-bookmark-0")).toHaveTextContent(
      "Chapter One · 40% through chapter",
    );

    await userEvent.click(screen.getByTestId("nav-bookmark-note-0"));
    await userEvent.type(screen.getByTestId("annotation-label-input"), "Opening scene");
    await userEvent.click(screen.getByTestId("annotation-note-save"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_annotation", {
        id: 9,
        patch: { label: "Opening scene", note: "" },
      }),
    );
    const row = await screen.findByTestId("nav-bookmark-0");
    expect(row).toHaveTextContent("Opening scene");
    expect(row).toHaveTextContent("Chapter One · 40% through chapter");
  });
});

describe("Bookmark label popover", () => {
  const HINT = "Chapter One · 55% through chapter · Saved just now";

  async function bookmarkAtSection2() {
    renderReader();
    await screen.findByTestId("reader-view");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    lastFakeHandle().emitRelocate({ locator: FAKE_LOCATOR.section2, totalProgression: 0.55 });
    await waitFor(() => expect(screen.getByTestId("reader-position")).toHaveTextContent("55%"));
    fireEvent.click(screen.getByTestId("reader-bookmark"));
    await screen.findByTestId("bookmark-label-popover");
  }

  it("carries the reader theme into the portaled card (UAT: dark theme)", async () => {
    window.localStorage.setItem(
      READER_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        preferences: { ...DEFAULT_READER_PREFERENCES, theme: "dark" },
        themePinned: true,
      }),
    );
    await bookmarkAtSection2();

    const background = screen
      .getByTestId("bookmark-label-popover")
      .style.getPropertyValue("--popover");
    expect(background.toLowerCase()).toBe("#101013");
  });

  it("opens under the bookmark button after creation and commits the label on Enter", async () => {
    await bookmarkAtSection2();

    expect(screen.getByTestId("bookmark-label-hint")).toHaveTextContent(HINT);
    expect(screen.getByTestId("bookmark-label-input")).toHaveFocus();
    expect(screen.queryByText("Bookmark (Ctrl+B)")).not.toBeInTheDocument();

    await userEvent.type(screen.getByTestId("bookmark-label-input"), "Opening scene");
    await userEvent.keyboard("{Enter}");

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_annotation", {
        id: 1,
        patch: { label: "Opening scene" },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("bookmark-label-popover")).not.toBeInTheDocument(),
    );
  });

  it("keeps the typed label on Escape and clamps it at 50 characters", async () => {
    await bookmarkAtSection2();

    const input = screen.getByTestId("bookmark-label-input");
    await userEvent.type(input, "x".repeat(60));
    expect(input).toHaveValue("x".repeat(50));

    await userEvent.keyboard("{Escape}");

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_annotation", {
        id: 1,
        patch: { label: "x".repeat(50) },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("bookmark-label-popover")).not.toBeInTheDocument(),
    );
  });

  it("commits the label when the popover loses the pointer outside", async () => {
    await bookmarkAtSection2();

    await userEvent.type(screen.getByTestId("bookmark-label-input"), "note to self");
    await userEvent.click(screen.getByTestId("reader-content"));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_annotation", {
        id: 1,
        patch: { label: "note to self" },
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("bookmark-label-popover")).not.toBeInTheDocument(),
    );
  });

  it("leaves the label unset when the popover closes with an empty draft", async () => {
    await bookmarkAtSection2();

    await userEvent.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByTestId("bookmark-label-popover")).not.toBeInTheDocument(),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("update_annotation", expect.anything());
  });

  it("removes the bookmark and drops the draft on a second Ctrl+B", async () => {
    await bookmarkAtSection2();
    await userEvent.type(screen.getByTestId("bookmark-label-input"), "draft");

    fireEvent.keyDown(window, { key: "b", ctrlKey: true });

    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("delete_annotation", { id: 1 }));
    await waitFor(() =>
      expect(screen.queryByTestId("bookmark-label-popover")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("reader-bookmark")).toHaveAttribute("aria-pressed", "false"),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("update_annotation", expect.anything());
  });

  it("rebinds to a new bookmark after moving on, leaving the first unlabeled", async () => {
    await bookmarkAtSection2();
    await userEvent.type(screen.getByTestId("bookmark-label-input"), "First draft");

    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [makeBook()],
      get_reading_progress: null,
      save_reading_progress: null,
      list_annotations: [],
      create_annotation: makeAnnotation({
        id: 2,
        kind: "bookmark",
        cfi: FAKE_LOCATOR.section1,
        chapterHref: "chapter1.xhtml",
        pageNumber: null,
        rects: null,
        text: null,
      }),
      update_annotation: null,
      delete_annotation: true,
    });
    lastFakeHandle().emitRelocate({ locator: FAKE_LOCATOR.section1, totalProgression: 0.1 });
    await waitFor(() => expect(screen.getByTestId("reader-position")).toHaveTextContent("10%"));
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });

    // The old popover stays mounted while the second create round-trips; wait for the rebind hint first.
    await waitFor(
      () =>
        expect(screen.getByTestId("bookmark-label-hint")).toHaveTextContent(
          "Chapter One · 10% through chapter · Saved just now",
        ),
      { timeout: 5000 },
    );
    const popover = screen.getByTestId("bookmark-label-popover");
    expect(within(popover).getByTestId("bookmark-label-input")).toHaveValue("");

    await userEvent.type(within(popover).getByTestId("bookmark-label-input"), "Second draft");
    await userEvent.keyboard("{Enter}");

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_annotation", {
        id: 2,
        patch: { label: "Second draft" },
      }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("update_annotation", {
      id: 1,
      patch: { label: "First draft" },
    });
  });

  it("labels a PDF bookmark and names the page in the hint", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [
        makeBook({
          id: 1,
          format: "pdf",
          path: "/tmp/library/minimal.pdf",
          title: "A Minimal PDF",
        }),
      ],
      get_reading_progress: null,
      save_reading_progress: null,
      list_annotations: [],
      create_annotation: makeAnnotation({
        id: 4,
        kind: "bookmark",
        cfi: null,
        chapterHref: null,
        pageNumber: 1,
        rects: null,
        text: null,
      }),
      update_annotation: null,
      delete_annotation: true,
    });

    fireEvent.click(screen.getByTestId("reader-bookmark"));

    const popover = await screen.findByTestId("bookmark-label-popover");
    expect(within(popover).getByTestId("bookmark-label-hint")).toHaveTextContent(
      "Page 1 · Saved just now",
    );

    await userEvent.type(within(popover).getByTestId("bookmark-label-input"), "Front matter");
    await userEvent.keyboard("{Enter}");

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_annotation", {
        id: 4,
        patch: { label: "Front matter" },
      }),
    );
  });
});

describe("ReaderNavigation", () => {
  it("lists the engine's EPUB contents and jumps through the engine", async () => {
    renderReader();

    await openNavigation();
    expect(await screen.findByTestId("toc-item-0")).toHaveTextContent("Chapter One");
    expect(screen.getByTestId("toc-item-1")).toHaveTextContent("Chapter Two");

    await userEvent.click(screen.getByTestId("toc-item-1"));
    expect(lastFakeHandle().goTo).toHaveBeenCalledWith(JSON.stringify({ href: "chapter2.xhtml" }));
    expect(screen.queryByTestId("reader-nav")).not.toBeInTheDocument();
    expect(invokeMock).not.toHaveBeenCalledWith("get_book_toc", { bookId: 1 });
  });

  it("hints every EPUB navigation tab with its shortcut and exposes aria-keyshortcuts", async () => {
    renderReader();

    await openNavigation();
    await screen.findByTestId("nav-tab-contents");

    const hints = [
      ["nav-tab-contents", "Control+Shift+C", "The book's chapters, in order. (Ctrl+Shift+C)"],
      [
        "nav-tab-bookmarks",
        "Control+Shift+B",
        "Pages you saved, so you can return to them. (Ctrl+Shift+B)",
      ],
      [
        "nav-tab-highlights",
        "Control+Shift+H",
        "Text you highlighted, with any notes you added. (Ctrl+Shift+H)",
      ],
    ] as const;

    for (const [testId, keyshortcuts, tooltip] of hints) {
      const trigger = screen.getByTestId(testId);
      expect(trigger).toHaveAttribute("aria-keyshortcuts", keyshortcuts);
      fireEvent.focus(trigger);
      await screen.findByRole("tooltip", { name: tooltip });
    }

    expect(screen.queryByTestId("nav-tab-search")).toBeNull();
  });

  it("hints the in-book search button with its primary shortcut", async () => {
    renderReader();
    await screen.findByTestId("reader-view");

    const searchButton = screen.getByRole("button", { name: "Search in book" });
    expect(searchButton).toHaveAttribute("aria-keyshortcuts", "Control+F");
    fireEvent.focus(searchButton);
    await screen.findByRole("tooltip", { name: "Search in book (Ctrl+F)" });
  });

  it("hints the PDF Contents tab with the contents shortcut", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    await openNavigation();

    const outline = await screen.findByTestId("nav-tab-outline");
    expect(outline).toHaveTextContent("Contents");
    expect(outline).toHaveAttribute("aria-keyshortcuts", "Control+Shift+C");
    fireEvent.focus(outline);
    await screen.findByRole("tooltip", {
      name: "The document's own headings, in order. (Ctrl+Shift+C)",
    });
  });

  it("shows a loading state while the EPUB document is still opening", async () => {
    const { ReadiumEpubHandle } = await import("@/lib/epub/readiumEngine");
    vi.mocked(ReadiumEpubHandle.open).mockReturnValueOnce(new Promise(() => {}) as never);
    const book = makeBook();
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [book],
      get_reading_progress: null,
      save_reading_progress: null,
      list_annotations: [],
    });
    render(
      <ThemeStateProvider>
        <AppShell
          initialState={{
            view: "reader",
            section: { kind: "smart", id: "all-books" },
            selectedBookId: 1,
            libraryQuery: "",
          }}
        />
      </ThemeStateProvider>,
    );
    await screen.findByTestId("reader-view");

    await openNavigation();
    expect(await screen.findByText("Loading contents…")).toBeInTheDocument();
  });

  it("gives PDFs a Contents tab from the document outline that jumps to pages", async () => {
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
    expect(screen.getByTestId("nav-tab-outline")).toHaveTextContent("Contents");
    expect(screen.getByTestId("nav-tab-outline")).toHaveAttribute("data-state", "active");
    expect(screen.queryByTestId("nav-tab-pages")).toBeNull();
    expect(screen.queryByTestId("nav-pages")).toBeNull();
    expect(await screen.findByTestId("nav-outline-item-0")).toHaveTextContent("Chapter One");
    expect(screen.getByTestId("nav-outline-item-1")).toHaveTextContent("Part Two");
    expect(screen.getByTestId("nav-outline-item-2")).toHaveTextContent("Section Two-A");

    await userEvent.click(screen.getByTestId("nav-outline-item-1"));
    // PDF has no footer; the shell exposes data-reader-position for tests instead.
    await waitFor(() =>
      expect(screen.getByTestId("reader-view")).toHaveAttribute("data-reader-position", "50"),
    );

    await openNavigation();
    await userEvent.click(await screen.findByTestId("nav-outline-item-2"));
    await waitFor(() =>
      expect(screen.getByTestId("reader-view")).toHaveAttribute("data-reader-position", "100"),
    );
    expect(screen.queryByTestId("reader-nav")).not.toBeInTheDocument();
  });

  it("shows an empty contents state for documents without an outline", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    await openNavigation();
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

  it("places thumbnails beside the PDF presentation control and contents first on the right", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    const header = screen.getByTestId("reader-back").closest("header");
    expect(header).not.toBeNull();
    const order = Array.from(header!.children)
      .map((child) => child.getAttribute("data-testid"))
      .filter((id): id is string => id !== null);

    expect(order.indexOf("reader-sidebar-toggle")).toBe(order.indexOf("pdf-header-controls") + 1);

    expect(order.slice(order.indexOf("reader-title") + 1)).toEqual([
      "reader-nav-trigger",
      "reader-search",
      "reader-book-mode",
      "appearance-trigger",
      "reader-bookmark",
      "reader-settings",
    ]);
  });

  it("themes the portaled drawer with the active reader theme", async () => {
    render(
      <TooltipProvider>
        <ReaderNavigation
          open
          onOpenChange={() => {}}
          book={makeBook()}
          onJump={() => {}}
          epubToc={null}
          pdfOutline={null}
          annotations={[]}
          onAnnotationJump={() => {}}
          onDeleteAnnotation={() => {}}
          onUpdateAnnotation={() => {}}
          tab="contents"
          onTabChange={() => {}}
          colorFor={() => "#facc15"}
          theme="dark"
        />
      </TooltipProvider>,
    );

    const drawer = await screen.findByTestId("reader-nav");
    expect(drawer.getAttribute("style")).toContain("--popover: #101013");
  });
});

describe("Reader presentation mode (issue #65)", () => {
  it("toggles with Ctrl+L, hides the chrome, and exits with Esc", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");
    expect(screen.queryByTestId("reader-footer")).toBeNull();
    expect(screen.getByTestId("reader-title")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "l", ctrlKey: true });
    expect(screen.getByTestId("reader-view")).toHaveAttribute("data-pdf-presentation", "true");
    expect(screen.queryByTestId("reader-title")).toBeNull();
    expect(screen.queryByTestId("reader-footer")).toBeNull();
    expect(screen.queryByTestId("reader-footer-hover-zone")).toBeNull();
    expect(screen.getByTestId("pdf-presentation-bar")).toBeInTheDocument();
    expect(screen.queryByTestId("pdf-toolbar")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("reader-view")).not.toHaveAttribute("data-pdf-presentation");
    expect(screen.getByTestId("reader-title")).toBeInTheDocument();
    expect(screen.queryByTestId("reader-footer")).toBeNull();
    expect(screen.getByTestId("pdf-toolbar")).toBeInTheDocument();
  });

  it("toggles back off with Ctrl+L", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    fireEvent.keyDown(window, { key: "l", ctrlKey: true });
    expect(screen.getByTestId("reader-view")).toHaveAttribute("data-pdf-presentation", "true");
    fireEvent.keyDown(window, { key: "l", ctrlKey: true });
    expect(screen.getByTestId("reader-view")).not.toHaveAttribute("data-pdf-presentation");
  });

  it("flips whole pages with PageDown, Space, and Shift+Space while presenting", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    fireEvent.keyDown(window, { key: "l", ctrlKey: true });
    fireEvent.keyDown(window, { key: "PageDown" });
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );

    fireEvent.keyDown(window, { key: " " });
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 3"),
    );

    fireEvent.keyDown(window, { key: " ", shiftKey: true });
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );
  });
});

describe("Reader EPUB presentation mode (issue #64)", () => {
  it("toggles with Ctrl+L, hides the chrome, and exits with Esc", async () => {
    renderReader("epub");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    expect(screen.getByTestId("reader-footer")).toBeInTheDocument();
    expect(screen.getByTestId("reader-title")).toBeInTheDocument();
    expect(screen.getByTestId("epub-presentation-toggle")).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "l", ctrlKey: true });
    expect(screen.getByTestId("reader-view")).toHaveAttribute("data-epub-presentation", "true");
    expect(screen.queryByTestId("reader-title")).toBeNull();
    expect(screen.queryByTestId("reader-footer")).toBeNull();
    expect(screen.queryByTestId("reader-footer-hover-zone")).toBeNull();
    expect(screen.getByTestId("epub-presentation-bar")).toBeInTheDocument();
    expect(screen.getByTestId("reader-view")).not.toHaveAttribute("data-pdf-presentation");

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("reader-view")).not.toHaveAttribute("data-epub-presentation");
    expect(screen.getByTestId("reader-title")).toBeInTheDocument();
    expect(screen.getByTestId("reader-footer")).toBeInTheDocument();
    expect(screen.getByTestId("epub-presentation-toggle")).toBeInTheDocument();
  });

  it("toggles back off with Ctrl+L", async () => {
    renderReader("epub");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    fireEvent.keyDown(window, { key: "l", ctrlKey: true });
    expect(screen.getByTestId("reader-view")).toHaveAttribute("data-epub-presentation", "true");
    fireEvent.keyDown(window, { key: "l", ctrlKey: true });
    expect(screen.getByTestId("reader-view")).not.toHaveAttribute("data-epub-presentation");
  });

  it("enters through the header toggle and turns pages from the floating bar", async () => {
    renderReader("epub");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    const handle = lastFakeHandle();

    fireEvent.click(screen.getByTestId("epub-presentation-toggle"));
    expect(screen.getByTestId("reader-view")).toHaveAttribute("data-epub-presentation", "true");
    expect(screen.getByTestId("epub-presentation-bar")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("epub-pres-next"));
    expect(handle.next).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("epub-pres-prev"));
    expect(handle.prev).toHaveBeenCalledTimes(1);

    handle.emitRelocate({
      fraction: 0.5,
      section: { current: 1, total: 2 },
      totalProgression: 0.6,
    });
    await waitFor(() =>
      expect(screen.getByTestId("epub-section-indicator")).toHaveTextContent("Section 2 of 2"),
    );

    fireEvent.click(screen.getByTestId("epub-pres-exit"));
    expect(screen.getByTestId("reader-view")).not.toHaveAttribute("data-epub-presentation");
    expect(screen.queryByTestId("epub-presentation-bar")).toBeNull();
    expect(screen.getByTestId("reader-footer")).toBeInTheDocument();
    expect(handle.init).toHaveBeenCalledTimes(1);
    expect(handle.hostElement.isConnected).toBe(true);
  });
});

describe("Reader panel shortcuts", () => {
  it("toggles the page-thumbnails sidebar with Ctrl+Shift+T in the PDF reader", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");
    expect(screen.queryByTestId("pdf-sidebar")).toBeNull();

    fireEvent.keyDown(window, { key: "t", ctrlKey: true, shiftKey: true });
    expect(await screen.findByTestId("pdf-sidebar")).toBeInTheDocument();
    expect(screen.getByTestId("reader-sidebar-toggle")).toHaveAttribute("aria-pressed", "true");

    fireEvent.keyDown(window, { key: "t", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.queryByTestId("pdf-sidebar")).toBeNull());
  });

  it("leaves the thumbnails shortcut inert in the EPUB reader", async () => {
    renderReader("epub");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    fireEvent.keyDown(window, { key: "t", ctrlKey: true, shiftKey: true });
    expect(screen.queryByTestId("reader-sidebar-toggle")).toBeNull();
    expect(screen.queryByTestId("pdf-sidebar")).toBeNull();
  });

  it("toggles the appearance popover with Ctrl+Shift+A and closes it again", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");
    expect(screen.queryByTestId("appearance-content")).toBeNull();

    fireEvent.keyDown(window, { key: "a", ctrlKey: true, shiftKey: true });
    expect(await screen.findByTestId("appearance-content")).toBeInTheDocument();
    expect(screen.getByTestId("appearance-content")).not.toHaveFocus();

    fireEvent.keyDown(window, { key: "a", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.queryByTestId("appearance-content")).toBeNull());
  });

  it("closes the appearance popover on Escape", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    fireEvent.keyDown(window, { key: "a", ctrlKey: true, shiftKey: true });
    await screen.findByTestId("appearance-content");

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("appearance-content")).toBeNull());
  });

  it("opens the contents drawer on its default tab with Ctrl+Shift+C and closes on repeat", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");
    expect(screen.queryByTestId("reader-nav")).toBeNull();

    fireEvent.keyDown(window, { key: "c", ctrlKey: true, shiftKey: true });
    const drawer = await screen.findByTestId("reader-nav");
    expect(drawer).toHaveAttribute("data-side", "right");
    expect(screen.getByTestId("nav-tab-outline")).toHaveAttribute("data-state", "active");
    expect(drawer).not.toContainElement(document.activeElement as HTMLElement);

    fireEvent.keyDown(window, { key: "c", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.queryByTestId("reader-nav")).toBeNull());
  });

  it("opens the EPUB contents drawer on the Contents tab", async () => {
    renderReader("epub");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    fireEvent.keyDown(window, { key: "c", ctrlKey: true, shiftKey: true });
    expect(await screen.findByTestId("reader-nav")).toBeInTheDocument();
    expect(screen.getByTestId("nav-tab-contents")).toHaveAttribute("data-state", "active");
  });

  it("opens the Bookmarks and Highlights tabs with Ctrl+Shift+B and Ctrl+Shift+H", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    fireEvent.keyDown(window, { key: "b", ctrlKey: true, shiftKey: true });
    expect(await screen.findByTestId("reader-nav")).toBeInTheDocument();
    expect(screen.getByTestId("nav-tab-bookmarks")).toHaveAttribute("data-state", "active");

    fireEvent.keyDown(window, { key: "b", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.queryByTestId("reader-nav")).toBeNull());

    fireEvent.keyDown(window, { key: "h", ctrlKey: true, shiftKey: true });
    expect(await screen.findByTestId("reader-nav")).toBeInTheDocument();
    expect(screen.getByTestId("nav-tab-highlights")).toHaveAttribute("data-state", "active");
  });

  it("closes an open drawer from any drawer shortcut without switching tabs", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    fireEvent.keyDown(window, { key: "b", ctrlKey: true, shiftKey: true });
    await screen.findByTestId("reader-nav");
    expect(screen.getByTestId("nav-tab-bookmarks")).toHaveAttribute("data-state", "active");

    fireEvent.keyDown(window, { key: "h", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.queryByTestId("reader-nav")).toBeNull());
  });

  it("keeps arrows and space turning pages after a shortcut opens a panel", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    fireEvent.keyDown(window, { key: "a", ctrlKey: true, shiftKey: true });
    await screen.findByTestId("appearance-content");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 2 of 3"),
    );
    fireEvent.keyDown(window, { key: " " });
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toHaveTextContent("Page 3 of 3"),
    );
  });

  it("labels the panel buttons with their keys and aria-keyshortcuts", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    const thumbnails = screen.getByTestId("reader-sidebar-toggle");
    const appearance = screen.getByTestId("appearance-trigger");
    const contents = screen.getByTestId("reader-nav-trigger");

    expect(thumbnails).toHaveAccessibleName("Toggle page thumbnails");
    expect(thumbnails).toHaveAttribute("aria-keyshortcuts", "Control+Shift+T");
    expect(appearance).toHaveAttribute("aria-keyshortcuts", "Control+Shift+A");
    expect(contents).toHaveAttribute("aria-keyshortcuts", "Control+Shift+C");

    for (const [testId, label] of [
      ["reader-sidebar-toggle", "Page thumbnails (Ctrl+Shift+T)"],
      ["appearance-trigger", "Appearance (Ctrl+Shift+A)"],
      ["reader-nav-trigger", "Contents (Ctrl+Shift+C)"],
    ] as const) {
      const trigger = screen.getByTestId(testId);
      fireEvent.focus(trigger);
      await screen.findByRole("tooltip", { name: label });
    }
  });
});

describe("ReaderAppearance", () => {
  it("changes the reader theme, layout, and font family", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    const content = await screen.findByTestId("appearance-content");
    expect(content).toBeInTheDocument();

    const themeGroup = screen.getByTestId("pref-theme");
    expect(within(themeGroup).getByRole("radio", { name: "Default" })).toBeChecked();
    expect(
      within(themeGroup)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("aria-label")),
    ).toEqual(["Default", "Light", "Dark", "Paper", "High contrast", "Blue", "Mint"]);

    await userEvent.click(screen.getByRole("radio", { name: "Paper" }));
    expect(screen.getByTestId("reader-view")).toHaveAttribute("data-theme", "paper");

    await userEvent.click(screen.getByRole("radio", { name: "Light" }));
    const lightView = screen.getByTestId("reader-view");
    expect(lightView).toHaveAttribute("data-theme", "light");
    expect(lightView.style.getPropertyValue("--background")).toBe("#ffffff");
    expect(lightView.style.getPropertyValue("--foreground")).toBe("#1f2328");
    expect(lightView).toHaveStyle({ colorScheme: "light" });

    await userEvent.click(screen.getByRole("radio", { name: "High contrast" }));
    expect(screen.getByTestId("reader-view")).toHaveAttribute("data-theme", "contrast");
    expect(document.querySelector('[data-testid="epub-reader"]')).toHaveStyle({
      colorScheme: "dark",
    });

    await userEvent.click(within(themeGroup).getByRole("radio", { name: "Default" }));
    const defaultView = screen.getByTestId("reader-view");
    expect(defaultView).toHaveAttribute("data-theme", "default");
    expect(defaultView.style.getPropertyValue("--background")).toBe("");

    await userEvent.click(screen.getByRole("radio", { name: "Scrolling" }));
    expect(await screen.findByTestId("epub-reader")).toHaveAttribute("data-layout", "scrolling");
    const handle = lastFakeHandle();
    await waitFor(() => expect(handle.setFlow).toHaveBeenCalledWith("scrolled"));

    await userEvent.click(screen.getByRole("radio", { name: "Serif" }));
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith({
        fontSize: 100,
        lineHeight: 0,
        fontFamily: "serif",
        columnCount: 2,
        wordSpacing: 0,
        letterSpacing: 0,
        paragraphSpacing: 0,
        pageGutter: 10,
        textAlign: "auto",
        foreground: null,
        theme: "default",
      }),
    );
  });

  it("exposes font size and line spacing sliders", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    const content = await screen.findByTestId("appearance-content");

    expect(content).toHaveTextContent("Font size");
    expect(content).toHaveTextContent("100%");
    expect(content).toHaveTextContent("Line spacing");
    expect(content).toHaveTextContent("Default");
    expect(screen.getByLabelText("Font size")).toBeInTheDocument();
    expect(screen.getByLabelText("Line spacing")).toBeInTheDocument();
  });

  it("steps the font size along the Readium scale and resets to 100%", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    await screen.findByTestId("appearance-content");
    const handle = lastFakeHandle();

    const slider = screen.getByTestId("pref-font-size");
    const thumb = within(slider).getByRole("slider");
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith({
        fontSize: 137.5,
        lineHeight: 0,
        fontFamily: null,
        columnCount: 2,
        wordSpacing: 0,
        letterSpacing: 0,
        paragraphSpacing: 0,
        pageGutter: 10,
        textAlign: "auto",
        foreground: null,
        theme: "default",
      }),
    );
    expect(screen.getByTestId("appearance-content")).toHaveTextContent("137.5%");

    const reset = screen.getByTestId("pref-font-size-reset");
    expect(reset).toBeEnabled();
    await userEvent.click(reset);
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith({
        fontSize: 100,
        lineHeight: 0,
        fontFamily: null,
        columnCount: 2,
        wordSpacing: 0,
        letterSpacing: 0,
        paragraphSpacing: 0,
        pageGutter: 10,
        textAlign: "auto",
        foreground: null,
        theme: "default",
      }),
    );
    await waitFor(() => expect(screen.getByTestId("pref-font-size-reset")).toBeDisabled());
  });

  it("steps the line spacing along the reading-system scale and resets to default", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    await screen.findByTestId("appearance-content");
    const handle = lastFakeHandle();

    const thumb = within(screen.getByTestId("pref-line-height")).getByRole("slider");
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith({
        fontSize: 100,
        lineHeight: 1.125,
        fontFamily: null,
        columnCount: 2,
        wordSpacing: 0,
        letterSpacing: 0,
        paragraphSpacing: 0,
        pageGutter: 10,
        textAlign: "auto",
        foreground: null,
        theme: "default",
      }),
    );
    expect(screen.getByTestId("appearance-content")).toHaveTextContent("1.125");

    const reset = screen.getByTestId("pref-line-height-reset");
    expect(reset).toBeEnabled();
    await userEvent.click(reset);
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith({
        fontSize: 100,
        lineHeight: 0,
        fontFamily: null,
        columnCount: 2,
        wordSpacing: 0,
        letterSpacing: 0,
        paragraphSpacing: 0,
        pageGutter: 10,
        textAlign: "auto",
        foreground: null,
        theme: "default",
      }),
    );
    await waitFor(() => expect(screen.getByTestId("pref-line-height-reset")).toBeDisabled());
  });

  it("offers the reading-system font families over the publisher default", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    await screen.findByTestId("appearance-content");
    const handle = lastFakeHandle();

    await userEvent.click(screen.getByRole("radio", { name: "Old Style" }));
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ fontFamily: "old-style" }),
      ),
    );

    await userEvent.click(screen.getByRole("radio", { name: "Readable" }));
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ fontFamily: "readable" }),
      ),
    );

    await userEvent.click(
      within(screen.getByTestId("pref-font-family")).getByRole("radio", { name: "Default" }),
    );
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ fontFamily: null }),
      ),
    );
  });

  it("offers 1–4 columns for paginated layout and keeps the choice while scrolling", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    await screen.findByTestId("appearance-content");
    const handle = lastFakeHandle();

    const columns = screen.getByTestId("pref-columns");
    expect(
      within(columns)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("aria-label")),
    ).toEqual(["One column", "2 columns", "3 columns", "4 columns"]);
    expect(within(columns).getByRole("radio", { name: "2 columns" })).toBeChecked();

    await userEvent.click(within(columns).getByRole("radio", { name: "4 columns" }));
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ columnCount: 4 }),
      ),
    );
    await userEvent.click(within(columns).getByRole("radio", { name: "One column" }));
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ columnCount: 1 }),
      ),
    );

    await userEvent.click(screen.getByRole("radio", { name: "Scrolling" }));
    expect(await screen.findByTestId("epub-reader")).toHaveAttribute("data-layout", "scrolling");
    expect(screen.queryByTestId("pref-columns")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "Paginated" }));
    const columnsAgain = await screen.findByTestId("pref-columns");
    expect(within(columnsAgain).getByRole("radio", { name: "One column" })).toBeChecked();
  });

  it("steps the text-layout spacing scales and resets each to publisher default", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    await screen.findByTestId("appearance-content");
    const handle = lastFakeHandle();

    const wordThumb = within(screen.getByTestId("pref-word-spacing")).getByRole("slider");
    fireEvent.keyDown(wordThumb, { key: "ArrowRight" });
    fireEvent.keyDown(wordThumb, { key: "ArrowRight" });
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ wordSpacing: 0.25 }),
      ),
    );
    expect(screen.getByTestId("appearance-content")).toHaveTextContent("0.25");
    await userEvent.click(screen.getByTestId("pref-word-spacing-reset"));
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ wordSpacing: 0 }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId("pref-word-spacing-reset")).toBeDisabled());

    const letterThumb = within(screen.getByTestId("pref-letter-spacing")).getByRole("slider");
    fireEvent.keyDown(letterThumb, { key: "ArrowRight" });
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ letterSpacing: 0.125 }),
      ),
    );
    await userEvent.click(screen.getByTestId("pref-letter-spacing-reset"));
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ letterSpacing: 0 }),
      ),
    );

    const paragraphThumb = within(screen.getByTestId("pref-paragraph-spacing")).getByRole("slider");
    fireEvent.keyDown(paragraphThumb, { key: "ArrowRight" });
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ paragraphSpacing: 0.25 }),
      ),
    );
    await userEvent.click(screen.getByTestId("pref-paragraph-spacing-reset"));
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ paragraphSpacing: 0 }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId("pref-paragraph-spacing-reset")).toBeDisabled());
  });

  it("applies explicit text alignment and restores publisher default with Auto", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    await screen.findByTestId("appearance-content");
    const handle = lastFakeHandle();

    const alignment = screen.getByTestId("pref-text-align");
    expect(within(alignment).getByRole("radio", { name: "Auto" })).toBeChecked();

    await userEvent.click(within(alignment).getByRole("radio", { name: "Justify" }));
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ textAlign: "justify" }),
      ),
    );

    await userEvent.click(within(alignment).getByRole("radio", { name: "Right" }));
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ textAlign: "right" }),
      ),
    );

    await userEvent.click(within(alignment).getByRole("radio", { name: "Auto" }));
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ textAlign: "auto" }),
      ),
    );
  });

  it("offers page margins for paginated layout and keeps the value while scrolling", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    await screen.findByTestId("appearance-content");
    const handle = lastFakeHandle();

    const margins = screen.getByTestId("pref-page-gutter");
    const thumb = within(margins).getByRole("slider");
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ pageGutter: 30 }),
      ),
    );

    await userEvent.click(screen.getByRole("radio", { name: "Scrolling" }));
    expect(await screen.findByTestId("epub-reader")).toHaveAttribute("data-layout", "scrolling");
    expect(screen.queryByTestId("pref-page-gutter")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "Paginated" }));
    const marginsAgain = await screen.findByTestId("pref-page-gutter");
    expect(within(marginsAgain).getByRole("slider")).toHaveAttribute("aria-valuenow", "3");

    await userEvent.click(screen.getByRole("button", { name: "Reset page margins" }));
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ pageGutter: 10 }),
      ),
    );
    expect(within(marginsAgain).getByRole("slider")).toHaveAttribute("aria-valuenow", "1");
  });

  it("overrides the foreground color on top of the theme and resets it", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    await screen.findByTestId("appearance-content");
    const handle = lastFakeHandle();

    expect(handle.setAppearance).toHaveBeenCalledWith(
      expect.objectContaining({ foreground: null }),
    );
    expect(screen.getByTestId("pref-foreground-reset")).toBeDisabled();

    await userEvent.click(screen.getByTestId("pref-foreground-parchment"));
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ foreground: "#f5efe0" }),
      ),
    );
    expect(screen.getByTestId("pref-foreground-parchment")).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(screen.getByTestId("pref-foreground-input"));
    const hexInput = await screen
      .findByTestId("pref-foreground-hex")
      .then((wrapper) => within(wrapper).getByRole("textbox"));
    fireEvent.change(hexInput, { target: { value: "#336" } });
    expect(handle.setAppearance).not.toHaveBeenCalledWith(
      expect.objectContaining({ foreground: "#336" }),
    );
    fireEvent.change(hexInput, { target: { value: "#336699" } });
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ foreground: "#336699" }),
      ),
    );

    const readout = screen.getByTestId("foreground-contrast");
    expect(readout).toHaveTextContent(/:1$/);

    await userEvent.click(screen.getByTestId("pref-foreground-reset"));
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ foreground: null }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId("pref-foreground-reset")).toBeDisabled());
    expect(screen.getByTestId("pref-foreground-parchment")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

describe("PDF appearance menu", () => {
  it("offers only the theme for fixed-layout PDFs and filters the pages", async () => {
    vi.mocked(openPdfDocumentFromBook).mockResolvedValue(
      makeFakePdfDocument(3) as unknown as Awaited<ReturnType<typeof openPdfDocumentFromBook>>,
    );
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [
        makeBook({
          id: 1,
          format: "pdf",
          path: "/tmp/library/minimal.pdf",
          title: "A Minimal PDF",
        }),
      ],
      get_reading_progress: null,
      save_reading_progress: null,
      list_annotations: [],
    });
    render(
      <ThemeStateProvider>
        <AppShell
          initialState={{
            view: "reader",
            section: { kind: "smart", id: "all-books" },
            selectedBookId: 1,
            libraryQuery: "",
          }}
        />
      </ThemeStateProvider>,
    );

    await screen.findByTestId("pdf-canvas");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    await screen.findByTestId("appearance-content");

    expect(screen.queryByTestId("pref-font-size")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pref-line-height")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pref-word-spacing")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pref-letter-spacing")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pref-paragraph-spacing")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pref-font-family")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pref-text-align")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pref-layout")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pref-columns")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pref-page-gutter")).not.toBeInTheDocument();

    const theme = screen.getByTestId("pref-theme");
    expect(
      within(theme)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("aria-label")),
    ).toEqual(["Default", "Light", "Smart dark", "Paper", "Invert", "High contrast"]);
    expect(screen.getByTestId("pdf-document").style.filter).toBe("");
    await userEvent.click(within(theme).getByRole("radio", { name: "High contrast" }));
    expect(screen.getByTestId("pdf-document").style.filter).toBe(
      "grayscale(1) invert(1) contrast(1.4)",
    );

    await userEvent.click(within(theme).getByRole("radio", { name: "Paper" }));
    const tint = screen.getByTestId("pdf-theme-tint");
    expect(tint.style.backgroundColor).toBe("rgb(246, 240, 228)");
    expect(tint.style.mixBlendMode).toBe("multiply");
    expect(screen.getByTestId("pdf-document").style.filter).toBe("");

    const header = screen.getByTestId("pdf-page-indicator").closest("header");
    expect(header).not.toBeNull();
    expect(header).toContainElement(screen.getByTestId("pdf-toolbar"));
    expect(screen.queryByTestId("pdf-reader")).not.toContainElement(
      screen.getByTestId("pdf-toolbar"),
    );
  });
});

describe("Reader theme scope", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("themes settings from the reader that opened it, not the app theme", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    window.localStorage.setItem(
      READER_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        preferences: { ...DEFAULT_READER_PREFERENCES, theme: "light" },
        themePinned: true,
      }),
    );

    renderReader();
    const readerView = await screen.findByTestId("reader-view");
    expect(readerView.style.getPropertyValue("--background")).toBe("#ffffff");

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    const windowEl = await screen.findByTestId("settings-window");
    expect(windowEl.style.getPropertyValue("--background")).toBe("#ffffff");
    expect(windowEl.style.getPropertyValue("--foreground")).toBe("#1f2328");
    expect(windowEl).toHaveStyle({ colorScheme: "light" });
  });

  it("repaints an unpinned settings window when the app theme flips", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

    renderReader();
    await screen.findByTestId("reader-view");
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));

    const windowEl = await screen.findByTestId("settings-window");
    expect(document.documentElement).toHaveClass("dark");
    expect(windowEl.style.getPropertyValue("--background")).toBe("#101013");

    await userEvent.click(screen.getByRole("radio", { name: "Light" }));

    expect(document.documentElement).not.toHaveClass("dark");
    await waitFor(() => expect(windowEl.style.getPropertyValue("--background")).toBe(""));
  });

  it("renders an explicitly selected Default as dark when the app is dark", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    window.localStorage.setItem(
      READER_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        preferences: { ...DEFAULT_READER_PREFERENCES, theme: "default" },
        themePinned: true,
      }),
    );

    renderReader();
    const readerView = await screen.findByTestId("reader-view");
    expect(readerView).toHaveAttribute("data-theme", "dark");
    expect(readerView.style.getPropertyValue("--background")).toBe("#101013");
    expect(screen.getByTestId("epub-reader")).toHaveStyle({ colorScheme: "dark" });

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const windowEl = await screen.findByTestId("settings-window");
    expect(windowEl.style.getPropertyValue("--background")).toBe("#101013");
  });

  it("repaints the open reader and window together when Viewer settings changes", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    window.localStorage.setItem(
      READER_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        preferences: { ...DEFAULT_READER_PREFERENCES, theme: "light" },
        themePinned: true,
      }),
    );

    renderReader();
    await screen.findByTestId("reader-view");
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const windowEl = await screen.findByTestId("settings-window");

    await userEvent.click(screen.getByRole("button", { name: "Viewer settings" }));
    await userEvent.click(screen.getByRole("radio", { name: "Paper" }));

    expect(screen.getByTestId("reader-view")).toHaveAttribute("data-theme", "paper");
    expect(windowEl.style.getPropertyValue("--background")).toBe("#f6f0e4");
  });

  it("themes a reader tooltip through the same scope", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    window.localStorage.setItem(
      READER_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        preferences: { ...DEFAULT_READER_PREFERENCES, theme: "light" },
        themePinned: true,
      }),
    );

    renderReader();
    const back = await screen.findByTestId("reader-back");
    await userEvent.hover(back);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.style.getPropertyValue("--background")).toBe("#ffffff");
    expect(tooltip.style.getPropertyValue("--foreground")).toBe("#1f2328");
  });
});

describe("Reader book mode toolbar control", () => {
  /**
   * Story 25/26: the header toggle next to the appearance popover is the
   * same shared flag, so both readers carry one control with one behavior.
   */
  async function expectToolbarToReflectAndPersist(format: "epub" | "pdf", readyTestId: string) {
    window.localStorage.setItem(
      READER_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        preferences: { ...DEFAULT_READER_PREFERENCES, bookMode: true },
        themePinned: false,
      }),
    );
    renderReader(format);

    await screen.findByTestId(readyTestId);
    const toggle = screen.getByTestId("reader-book-mode");
    expect(toggle).toHaveAccessibleName("Book mode");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle.querySelector("svg")).toHaveClass("fill-current");

    await userEvent.click(toggle);
    const released = screen.getByTestId("reader-book-mode");
    expect(released).toHaveAttribute("aria-pressed", "false");
    expect(released.querySelector("svg")).not.toHaveClass("fill-current");
    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem(READER_SETTINGS_STORAGE_KEY) ?? "{}");
      expect(stored.preferences.bookMode).toBe(false);
    });
  }

  it("reflects the persisted choice and writes toggles for EPUB", async () => {
    await expectToolbarToReflectAndPersist("epub", "reader-view");
  });

  it("reflects the persisted choice and writes toggles for PDF", async () => {
    await expectToolbarToReflectAndPersist("pdf", "pdf-book-canvas");
  });

  /**
   * UAT kept the header toggle as the only control (tuxbooks-9pr.10): the
   * popover carries theme and reflow controls only, in both readers.
   */
  async function expectNoBookModeInPopover(format: "epub" | "pdf", readyTestId: string) {
    renderReader(format);
    await screen.findByTestId(readyTestId);
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    await screen.findByTestId("appearance-content");
    expect(screen.queryByTestId("pref-book-mode")).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Book mode" })).not.toBeInTheDocument();
  }

  it("keeps book mode out of the appearance popover for EPUB", async () => {
    await expectNoBookModeInPopover("epub", "reader-view");
  });

  it("keeps book mode out of the appearance popover for PDF", async () => {
    await expectNoBookModeInPopover("pdf", "pdf-canvas");
  });
});

describe("Reader book mode shortcut", () => {
  /**
   * Story 25/26: the `b` chord flips the same shared flag as the header
   * toggle, so one keyboard path behaves identically in both readers.
   */
  it("mounts and unmounts the PDF spread view with b", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    fireEvent.keyDown(window, { key: "b" });
    await screen.findByTestId("pdf-book-canvas");
    await waitFor(() =>
      expect(screen.getByTestId("reader-book-mode")).toHaveAttribute("aria-pressed", "true"),
    );

    fireEvent.keyDown(window, { key: "b" });
    await waitFor(() => expect(screen.queryByTestId("pdf-book-canvas")).not.toBeInTheDocument());
    await screen.findByTestId("pdf-canvas");
    expect(screen.getByTestId("reader-book-mode")).toHaveAttribute("aria-pressed", "false");
  });

  it("derives the EPUB paginated two-column flow with b", async () => {
    window.localStorage.setItem(
      READER_SETTINGS_STORAGE_KEY,
      JSON.stringify({
        preferences: { ...DEFAULT_READER_PREFERENCES, layout: "scrolling" },
        themePinned: false,
      }),
    );
    renderReader("epub");
    const surface = await screen.findByTestId("epub-reader");
    expect(surface).toHaveAttribute("data-layout", "scrolling");

    fireEvent.keyDown(window, { key: "b" });
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-layout", "paginated"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("reader-book-mode")).toHaveAttribute("aria-pressed", "true"),
    );

    fireEvent.keyDown(window, { key: "b" });
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-layout", "scrolling"),
    );
  });

  it("keeps b out of the search overlay's input", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = await screen.findByTestId("reader-search-input");
    await userEvent.click(input);
    await userEvent.keyboard("b");
    expect(input).toHaveValue("b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("pdf-book-canvas")).not.toBeInTheDocument();
    expect(screen.getByTestId("reader-book-mode")).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps b out of the page number field", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    const input = await screen.findByTestId("pdf-page-input");
    await waitFor(() => expect(input).toBeEnabled());
    await userEvent.click(input);
    await userEvent.keyboard("b");
    expect(input).toHaveValue("b");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("pdf-book-canvas")).not.toBeInTheDocument();
    expect(screen.getByTestId("reader-book-mode")).toHaveAttribute("aria-pressed", "false");
  });

  it("stays inert while presenting and resumes after leaving", async () => {
    renderReader("pdf");
    await screen.findByTestId("pdf-canvas");

    fireEvent.keyDown(window, { key: "l", ctrlKey: true });
    expect(screen.getByTestId("reader-view")).toHaveAttribute("data-pdf-presentation", "true");

    fireEvent.keyDown(window, { key: "b" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByTestId("pdf-book-canvas")).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "b" });
    await screen.findByTestId("pdf-book-canvas");
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
    vi.mocked(openPdfDocumentFromBook).mockResolvedValue(
      makeFakePdfDocument(3) as unknown as Awaited<ReturnType<typeof openPdfDocumentFromBook>>,
    );
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 2, collectionCount: 0 },
      list_books: [epub, pdf],
      get_reading_progress: null,
      save_reading_progress: null,
      list_annotations: [],
    });
    render(
      <ThemeStateProvider>
        <AppShell
          initialState={{
            view: "reader",
            section: { kind: "smart", id: "all-books" },
            selectedBookId: 1,
            libraryQuery: "",
          }}
        />
      </ThemeStateProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    await openNavigation();
    expect(await screen.findByTestId("toc-item-0")).toHaveTextContent("Chapter One");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("reader-nav")).not.toBeInTheDocument());

    await userEvent.click(screen.getByTestId("reader-back"));
    await screen.findByTestId("library-view");
    fireEvent.doubleClick(await screen.findByLabelText("A Minimal PDF (PDF)"));
    await screen.findByTestId("book-detail");
    await userEvent.click(screen.getByTestId("detail-continue"));

    await screen.findByTestId("pdf-canvas");
    expect(screen.queryByTestId("epub-reader")).not.toBeInTheDocument();
    expect(screen.getByTestId("reader-view")).toHaveAttribute("data-reader-position", "0");
    await openNavigation();
    expect(await screen.findByTestId("nav-outline-item-0")).toHaveTextContent("Part One");
    expect(screen.queryByTestId("toc-item-0")).not.toBeInTheDocument();

    expect(fakeEpubHandles).toHaveLength(1);
    expect(fakeEpubHandles[0]!.close).toHaveBeenCalledTimes(1);
    expect(fakeEpubHandles[0]!.hostElement.isConnected).toBe(false);
  });
});

describe("Reader highlight toolbar", () => {
  const SELECTION_RECT = { x: 0.125, y: 0.125, width: 0.25, height: 0.0625 };
  let selectionSpy: ReturnType<typeof vi.spyOn> | null = null;

  afterEach(() => {
    selectionSpy?.mockRestore();
    selectionSpy = null;
  });

  function renderPdfShell({
    highlights = [],
    createResponse = makeAnnotation(),
    updateResponse = null,
  }: {
    highlights?: Annotation[];
    createResponse?: Annotation | null;
    updateResponse?: Annotation | null;
  } = {}) {
    vi.mocked(openPdfDocumentFromBook).mockResolvedValue(
      makeFakePdfDocument(3) as unknown as Awaited<ReturnType<typeof openPdfDocumentFromBook>>,
    );
    invokeMock.mockClear();
    mockInvoke({
      get_library_stats: { bookCount: 1, collectionCount: 0 },
      list_books: [
        makeBook({
          id: 1,
          format: "pdf",
          path: "/tmp/library/minimal.pdf",
          title: "A Minimal PDF",
        }),
      ],
      get_reading_progress: null,
      save_reading_progress: null,
      list_annotations: highlights,
      create_annotation: createResponse,
      update_annotation: updateResponse,
      delete_annotation: true,
    });
    return render(
      <ThemeStateProvider>
        <AppShell
          initialState={{
            view: "reader",
            section: { kind: "smart", id: "all-books" },
            selectedBookId: 1,
            libraryQuery: "",
          }}
        />
      </ThemeStateProvider>,
    );
  }

  /**
   * Stubs page 1's slot geometry and returns dispatchers for a drag-made
   * selection and a plain click on the page, both read back through a
   * mocked window.getSelection like the real reader does after pointerup.
   */
  async function stubPageOnePointer() {
    await screen.findByTestId("pdf-canvas");
    const pageSlot = document.querySelector('[data-pdf-slot="1"]') as HTMLElement;
    pageSlot.getBoundingClientRect = () => new DOMRect(0, 0, 512, 512);
    const anchor = document.createElement("span");
    pageSlot.appendChild(anchor);
    const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
    const dragSelection = {
      isCollapsed: false,
      rangeCount: 1,
      anchorNode: anchor,
      toString: () => "selected words",
      getRangeAt: () => ({ getClientRects: () => [new DOMRect(64, 64, 128, 32)] }),
      removeAllRanges: vi.fn(),
    };
    const collapsedSelection = {
      isCollapsed: true,
      rangeCount: 1,
      anchorNode: anchor,
      toString: () => "",
      removeAllRanges: vi.fn(),
    };
    selectionSpy = vi
      .spyOn(window, "getSelection")
      .mockReturnValue(dragSelection as unknown as Selection);
    return {
      async drag() {
        selectionSpy!.mockReturnValue(dragSelection as unknown as Selection);
        fireEvent.pointerUp(anchor);
        await tick();
      },
      async click(x: number, y: number) {
        selectionSpy!.mockReturnValue(collapsedSelection as unknown as Selection);
        fireEvent.pointerUp(anchor, { clientX: x, clientY: y });
        await tick();
      },
    };
  }

  it("creates a highlight from a fresh selection and removes it from the palette", async () => {
    renderPdfShell({
      createResponse: makeAnnotation({
        id: 4,
        kind: "highlight",
        pageNumber: 1,
        color: "yellow",
        text: "selected words",
        rects: [SELECTION_RECT],
      }),
    });
    const pointer = await stubPageOnePointer();

    await pointer.drag();
    expect(await screen.findByTestId("selection-toolbar")).toBeInTheDocument();
    expect(screen.queryByTestId("highlight-remove")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("highlight-color-yellow"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("create_annotation", {
        bookId: 1,
        annotation: {
          kind: "highlight",
          pageNumber: 1,
          rects: [SELECTION_RECT],
          text: "selected words",
          color: "yellow",
        },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("selection-toolbar")).not.toBeInTheDocument());

    await pointer.drag();
    expect(await screen.findByTestId("selection-toolbar")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("highlight-remove"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("delete_annotation", { id: 4 }));
    await waitFor(() => expect(screen.queryByTestId("selection-toolbar")).not.toBeInTheDocument());

    await pointer.drag();
    expect(await screen.findByTestId("selection-toolbar")).toBeInTheDocument();
    expect(screen.queryByTestId("highlight-remove")).not.toBeInTheDocument();
  });

  it("recolors an existing highlight instead of stacking a new one", async () => {
    const stored = makeAnnotation({
      id: 7,
      kind: "highlight",
      pageNumber: 1,
      color: "yellow",
      text: "selected words",
      rects: [SELECTION_RECT],
    });
    renderPdfShell({ highlights: [stored], updateResponse: { ...stored, color: "blue" } });
    const pointer = await stubPageOnePointer();

    await pointer.drag();
    expect(await screen.findByTestId("selection-toolbar")).toBeInTheDocument();
    expect(screen.getByTestId("highlight-remove")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("highlight-color-blue"));
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("update_annotation", {
        id: 7,
        patch: { color: "blue" },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId("selection-toolbar")).not.toBeInTheDocument());
  });

  it("removes an existing highlight addressed by a plain click", async () => {
    const stored = makeAnnotation({
      id: 9,
      kind: "highlight",
      pageNumber: 1,
      color: "blue",
      text: "the stored words",
      rects: [{ x: 0, y: 0, width: 0.5, height: 0.5 }],
    });
    renderPdfShell({ highlights: [stored] });
    const pointer = await stubPageOnePointer();

    await pointer.click(64, 64);
    expect(await screen.findByTestId("selection-toolbar")).toHaveTextContent("the stored words");
    fireEvent.click(screen.getByTestId("highlight-remove"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("delete_annotation", { id: 9 }));
    await waitFor(() => expect(screen.queryByTestId("selection-toolbar")).not.toBeInTheDocument());

    await pointer.click(480, 480);
    await waitFor(() => expect(screen.queryByTestId("selection-toolbar")).not.toBeInTheDocument());
  });
});

describe("Reader highlight target", () => {
  it("jumps to the highlight opened from the book detail view", async () => {
    const highlight = makeAnnotation({
      id: 77,
      kind: "highlight",
      cfi: FAKE_LOCATOR.section2,
      chapterHref: "chapter2.xhtml",
      pageNumber: null,
      text: "a stored passage",
      rects: null,
    });

    renderReader("epub", {
      annotations: [highlight],
      state: { readerTargetAnnotationId: 77 },
    });

    await screen.findByTestId("reader-view");
    await waitFor(() => expect(lastFakeHandle().goTo).toHaveBeenCalledWith(FAKE_LOCATOR.section2), {
      timeout: 5000,
    });
  });
});
