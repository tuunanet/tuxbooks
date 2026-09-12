import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Annotation } from "@/types/domain";

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
import { getPdfOutline, openPdfDocumentFromBook } from "@/lib/pdf/pdfEngine";
import { makeAnnotation, makeBook } from "./factories";
import { scrollTo, stubScrollGeometry } from "./mocks/dom";
import { makeFakePdfDocument } from "./mocks/pdfEngine";
import { lastFakeHandle, fakeEpubHandles, FAKE_LOCATOR } from "./mocks/readiumEngine";
import { invokeMock, mockInvoke } from "./mocks/bridge";

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
    vi.mocked(openPdfDocumentFromBook).mockResolvedValue(
      makeFakePdfDocument(3) as unknown as Awaited<ReturnType<typeof openPdfDocumentFromBook>>,
    );
  }
  invokeMock.mockClear();
  mockInvoke({
    get_library_stats: { bookCount: 1, collectionCount: 0 },
    list_books: [book],
    get_reading_progress: null,
    save_reading_progress: null,
    list_annotations: [],
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
    <AppShell
      initialState={{
        view: "reader",
        section: { kind: "smart", id: "all-books" },
        selectedBookId: 1,
        libraryQuery: "",
        metadataEditorBookId: null,
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

  it("opens the navigation drawer onto the Search tab", async () => {
    renderReader();

    expect(await screen.findByTestId("reader-view")).toBeInTheDocument();
    const searchButton = screen.getByRole("button", { name: "Search in book" });
    expect(searchButton).toBeEnabled();
    // The thumbnails sidebar is a PDF affordance; EPUBs have none.
    expect(screen.queryByTestId("reader-sidebar-toggle")).toBeNull();

    await userEvent.click(searchButton);
    expect(await screen.findByTestId("reader-nav")).toBeInTheDocument();
    expect(screen.getByTestId("reader-search-input")).toBeInTheDocument();
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

    // The engine-driven position report keeps the footer in sync: the
    // shell percent is the reported totalProgression, whatever flow the
    // reader is in.
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

    // End maps onto the end of the book's positions.
    fireEvent.keyDown(window, { key: "End" });
    await waitFor(() => expect(handle.goToTotalProgression).toHaveBeenCalledWith(1));
    // The engine reports its landing position.
    handle.emitRelocate({ fraction: 1, section: { current: 1, total: 2 }, totalProgression: 1 });
    await waitFor(() => expect(screen.getByTestId("reader-position")).toHaveTextContent("100%"));

    fireEvent.keyDown(window, { key: "Home" });
    await waitFor(() => expect(handle.goToTotalProgression).toHaveBeenCalledWith(0));
    handle.emitRelocate({ fraction: 0, section: { current: 0, total: 2 }, totalProgression: 0 });
    await waitFor(() => expect(screen.getByTestId("reader-position")).toHaveTextContent("0%"));
  });
});

describe("Reader bookmarks", () => {
  it("creates a persistent bookmark at the engine locator and removes it on toggle", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    // The relocate gives the shell a concrete CFI to bookmark.
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
    expect(screen.getByTestId("reader-bookmark")).toHaveAttribute("aria-pressed", "true");

    // The drawer lists the stored bookmark (from the create response).
    await openNavigation();
    await userEvent.click(await screen.findByTestId("nav-tab-bookmarks"));
    expect(await screen.findByTestId("nav-bookmark-0")).toBeInTheDocument();
    expect(screen.queryByText(/session only/i)).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");

    // Toggling again removes the bookmark at the same locator.
    fireEvent.click(screen.getByTestId("reader-bookmark"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("delete_annotation", { id: 1 }));
    expect(screen.getByTestId("reader-bookmark")).toHaveAttribute("aria-pressed", "false");
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
      <AppShell
        initialState={{
          view: "reader",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
          metadataEditorBookId: null,
        }}
      />,
    );
    await screen.findByTestId("reader-view");

    await openNavigation();
    await userEvent.click(await screen.findByTestId("nav-tab-bookmarks"));
    expect(await screen.findByTestId("nav-bookmark-0")).toHaveTextContent("Chapter One");

    await userEvent.click(screen.getByTestId("nav-tab-highlights"));
    const row = await screen.findByTestId("nav-highlight-0");
    expect(row).toHaveTextContent("the quoted words");
    expect(screen.getByTestId("nav-highlight-color-0")).toHaveStyle({ background: "#facc15" });

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
      <AppShell
        initialState={{
          view: "reader",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
          metadataEditorBookId: null,
        }}
      />,
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
    // Contents come from the rendering engine, not a backend command.
    expect(invokeMock).not.toHaveBeenCalledWith("get_book_toc", { bookId: 1 });
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
      <AppShell
        initialState={{
          view: "reader",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
          metadataEditorBookId: null,
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
    expect(vi.mocked(openPdfDocumentFromBook)).toHaveBeenCalledWith(1, "pdf");

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
    // Default (publisher colors) is the preselected neutral theme.
    const themeGroup = screen.getByTestId("pref-theme");
    expect(within(themeGroup).getByRole("radio", { name: "Default" })).toBeChecked();
    expect(
      within(themeGroup)
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["Default", "Light", "Paper", "Dark", "High contrast", "Blue", "Mint"]);

    await userEvent.click(screen.getByRole("radio", { name: "Paper" }));
    expect(screen.getByTestId("reader-view")).toHaveAttribute("data-theme", "paper");

    // Accessible presets apply like any other theme...
    await userEvent.click(screen.getByRole("radio", { name: "High contrast" }));
    expect(screen.getByTestId("reader-view")).toHaveAttribute("data-theme", "contrast");

    // ...and Default restores the publisher-owned colors (neutral state).
    await userEvent.click(within(themeGroup).getByRole("radio", { name: "Default" }));
    expect(screen.getByTestId("reader-view")).toHaveAttribute("data-theme", "default");

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
        pageGutter: 0,
        textAlign: "auto",
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
    // 0 on the reading-system scale means publication default.
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
    // Radix handles the keydown on the thumb (role=slider), not the root.
    const thumb = within(slider).getByRole("slider");
    // Two steps up the scale: 100% → 112.5% → 137.5%.
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
        pageGutter: 0,
        textAlign: "auto",
        theme: "default",
      }),
    );
    expect(screen.getByTestId("appearance-content")).toHaveTextContent("137.5%");

    // The explicit reset returns the default reading size.
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
        pageGutter: 0,
        textAlign: "auto",
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
    // From the 0 (publication default) sentinel: 0 → 1 → 1.125.
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
        pageGutter: 0,
        textAlign: "auto",
        theme: "default",
      }),
    );
    expect(screen.getByTestId("appearance-content")).toHaveTextContent("1.125");

    // The explicit reset returns the publication default (0 sentinel).
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
        pageGutter: 0,
        textAlign: "auto",
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

    // Default removes the override entirely — publisher styling wins.
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

    // Paginated exposes exactly 1, 2, 3, and 4 as Roman numerals ("II"
    // preselected by default); the stored value stays numeric.
    const columns = screen.getByTestId("pref-columns");
    expect(
      within(columns)
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["I", "II", "III", "IV"]);
    expect(within(columns).getByRole("radio", { name: "II" })).toBeChecked();

    // Every value is submitted as an explicit numeric target (never auto-fit).
    await userEvent.click(within(columns).getByRole("radio", { name: "IV" }));
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ columnCount: 4 }),
      ),
    );
    await userEvent.click(within(columns).getByRole("radio", { name: "I" }));
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ columnCount: 1 }),
      ),
    );

    // Scrolling hides the control and ignores the count — the stored
    // preference survives untouched.
    await userEvent.click(screen.getByRole("radio", { name: "Scrolling" }));
    expect(await screen.findByTestId("epub-reader")).toHaveAttribute("data-layout", "scrolling");
    expect(screen.queryByTestId("pref-columns")).not.toBeInTheDocument();

    // Back to paginated: I (1) is still the selected target.
    await userEvent.click(screen.getByRole("radio", { name: "Paginated" }));
    const columnsAgain = await screen.findByTestId("pref-columns");
    expect(within(columnsAgain).getByRole("radio", { name: "I" })).toBeChecked();
  });

  it("steps the text-layout spacing scales and resets each to publisher default", async () => {
    renderReader();

    await screen.findByTestId("reader-view");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    await screen.findByTestId("appearance-content");
    const handle = lastFakeHandle();

    // Word spacing: two steps up the rem scale → 0.25, then reset to 0.
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

    // Letter spacing: one step → 0.125, reset to 0.
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

    // Paragraph spacing: one step → 0.25, reset to 0.
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

    // Auto is the preselected publisher default.
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

    // Auto restores the publication's own alignment (sentinel, no override).
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
    // Three steps: 0 → 10px → 20px → 30px.
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    await waitFor(() =>
      expect(handle.setAppearance).toHaveBeenCalledWith(
        expect.objectContaining({ pageGutter: 30 }),
      ),
    );

    // Scrolling hides the pagination-scoped control; the value survives.
    await userEvent.click(screen.getByRole("radio", { name: "Scrolling" }));
    expect(await screen.findByTestId("epub-reader")).toHaveAttribute("data-layout", "scrolling");
    expect(screen.queryByTestId("pref-page-gutter")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "Paginated" }));
    const marginsAgain = await screen.findByTestId("pref-page-gutter");
    expect(within(marginsAgain).getByRole("slider")).toHaveAttribute("aria-valuenow", "3");
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
      <AppShell
        initialState={{
          view: "reader",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
          metadataEditorBookId: null,
        }}
      />,
    );

    await screen.findByTestId("pdf-canvas");
    fireEvent.click(screen.getByTestId("appearance-trigger"));
    await screen.findByTestId("appearance-content");

    // The reflow controls cannot act on a fixed layout: theme only.
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

    // Exactly the themes with a faithful filter mapping are offered, and a
    // choice lands on the rendered pages as a CSS filter.
    const theme = screen.getByTestId("pref-theme");
    expect(
      within(theme)
        .getAllByRole("radio")
        .map((radio) => radio.textContent),
    ).toEqual(["Default", "Light", "Paper", "Dark", "High contrast"]);
    expect(screen.getByTestId("pdf-document").style.filter).toBe("");
    await userEvent.click(within(theme).getByRole("radio", { name: "High contrast" }));
    expect(screen.getByTestId("pdf-document").style.filter).toBe(
      "grayscale(1) invert(1) contrast(1.4)",
    );
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
      <AppShell
        initialState={{
          view: "reader",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
          metadataEditorBookId: null,
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
      <AppShell
        initialState={{
          view: "reader",
          section: { kind: "smart", id: "all-books" },
          selectedBookId: 1,
          libraryQuery: "",
          metadataEditorBookId: null,
        }}
      />,
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

    // A fresh selection has no highlight to target: swatches create.
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

    // Selecting the highlighted text again targets it: the palette now
    // offers Remove, which deletes the annotation itself.
    await pointer.drag();
    expect(await screen.findByTestId("selection-toolbar")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("highlight-remove"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("delete_annotation", { id: 4 }));
    await waitFor(() => expect(screen.queryByTestId("selection-toolbar")).not.toBeInTheDocument());

    // The text is selectable again and no highlight is targeted.
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

    // A click inside the highlight's rect opens the palette onto it.
    await pointer.click(64, 64);
    expect(await screen.findByTestId("selection-toolbar")).toHaveTextContent("the stored words");
    fireEvent.click(screen.getByTestId("highlight-remove"));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("delete_annotation", { id: 9 }));
    await waitFor(() => expect(screen.queryByTestId("selection-toolbar")).not.toBeInTheDocument());

    // A click on unhighlighted page space reports no target.
    await pointer.click(480, 480);
    await waitFor(() => expect(screen.queryByTestId("selection-toolbar")).not.toBeInTheDocument());
  });
});
