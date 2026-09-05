import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@/lib/epub/epubEngine", async () => {
  const { makeFakeEpubModule } = await import("./mocks/epubEngine");
  return makeFakeEpubModule();
});

import { EpubReader } from "@/components/reader/EpubReader";
import type { ReaderAdapter } from "@/components/reader/readerModel";
import { ShortcutProvider } from "@/state/ShortcutProvider";
import { ReaderProvider } from "@/state/ReaderProvider";
import { invokeMock, mockInvoke } from "./mocks/tauri";
import { emitSearchResults, fakeEpubHandles, lastFakeHandle } from "./mocks/epubEngine";
import { makeAnnotation } from "./factories";
import type { Annotation } from "@/types/domain";

const SAVED_PROGRESS = {
  bookId: 1,
  chapterHref: "chapter2.xhtml",
  cfi: "epubcfi(/6/4!/4/2,/1:0,/1:42)",
  characterOffset: null,
  pageNumber: null,
  scrollOffset: null,
  progressPercent: 55,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function renderReader(props: { onTocLoad?: (toc: unknown[]) => void; bookId?: number } = {}) {
  const view = render(
    <ShortcutProvider>
      <ReaderProvider>
        <EpubReader
          book={{ ...makeBookShim(), id: props.bookId ?? 1 }}
          onTocLoad={props.onTocLoad}
        />
      </ReaderProvider>
    </ShortcutProvider>,
  );
  return {
    ...view,
    rerenderBook(bookId: number) {
      view.rerender(
        <ShortcutProvider>
          <ReaderProvider>
            <EpubReader book={{ ...makeBookShim(), id: bookId }} onTocLoad={props.onTocLoad} />
          </ReaderProvider>
        </ShortcutProvider>,
      );
    },
  };
}

// Local minimal book literal instead of importing factories (keeps this
// file's dependency surface small).
function makeBookShim() {
  return {
    id: 1,
    path: "/tmp/library/minimal.epub",
    format: "epub" as const,
    title: "A Minimal Book",
    subtitle: null,
    author: "Ada Lovelace",
    publisher: null,
    language: "en",
    isbn: null,
    description: null,
    coverPath: null,
    addedAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: null,
    available: true,
    fileSize: 1024,
    fileMtime: 1767225600,
    publicationDate: null,
    seriesId: null,
    seriesIndex: null,
    seriesName: null,
  };
}

function mockHappyPath(saved: typeof SAVED_PROGRESS | null) {
  mockInvoke({
    get_book_bytes: new ArrayBuffer(16),
    get_reading_progress: saved,
    save_reading_progress: null,
  });
}

describe("EpubReader lifecycle", () => {
  beforeEach(() => {
    fakeEpubHandles.length = 0;
  });

  it("loads the document, mounts the engine host, and becomes ready", async () => {
    mockHappyPath(null);
    const onTocLoad = vi.fn();

    renderReader({ onTocLoad });
    expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "loading");
    expect(screen.getByTestId("epub-loading")).toBeInTheDocument();

    const handle = await waitFor(() => {
      const current = fakeHandleOrThrow();
      return current;
    });
    expect(handle.open).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    expect(handle.init).toHaveBeenCalledWith(null);
    expect(handle.host.isConnected).toBe(true);
    expect(onTocLoad).toHaveBeenCalledWith([
      { label: "Chapter One", href: "chapter1.xhtml", subitems: [] },
      { label: "Chapter Two", href: "chapter2.xhtml", subitems: [] },
    ]);
    expect(invokeMock).toHaveBeenCalledWith("get_book_bytes", { bookId: 1 });
  });

  it("restores the saved CFI through engine init", async () => {
    mockHappyPath(SAVED_PROGRESS);

    renderReader();
    const handle = await waitFor(fakeHandleOrThrow);
    await waitFor(() => expect(handle.init).toHaveBeenCalled());
    expect(handle.init).toHaveBeenCalledWith("epubcfi(/6/4!/4/2,/1:0,/1:42)");
    expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready");
  });

  it("renders an honest error when the bytes cannot be loaded", async () => {
    mockInvoke({
      get_book_bytes: new Error("file went away"),
      get_reading_progress: null,
      save_reading_progress: null,
    });

    renderReader();
    expect(await screen.findByTestId("epub-error")).toHaveTextContent(
      "This EPUB could not be opened: file went away",
    );
  });

  it("closes the engine when the reader unmounts", async () => {
    mockHappyPath(null);
    const { unmount } = renderReader();
    const handle = await waitFor(fakeHandleOrThrow);
    await screen.findByTestId("epub-reader");

    unmount();
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(handle.host.isConnected).toBe(false);
  });

  it("closes the previous engine and mounts a fresh one when the book changes", async () => {
    mockHappyPath(null);

    const view = renderReader({ bookId: 1 });
    const first = await waitFor(fakeHandleOrThrow);
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    expect(first.host.isConnected).toBe(true);

    view.rerenderBook(2);
    const second = await waitFor(() => {
      expect(fakeEpubHandles.length).toBe(2);
      return fakeEpubHandles[1]!;
    });
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    // The old engine is closed and its host is detached; the new book's
    // host is the one connected to the document.
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(first.host.isConnected).toBe(false);
    expect(second.open).toHaveBeenCalledTimes(1);
    expect(second.host.isConnected).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("get_book_bytes", { bookId: 2 });
  });

  it("closes an open that finishes after the book changed", async () => {
    mockHappyPath(null);

    const view = renderReader({ bookId: 1 });
    const first = await waitFor(fakeHandleOrThrow);
    let resolveFirstOpen: () => void = () => {};
    first.open.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveFirstOpen = resolve)),
    );

    view.rerenderBook(2);
    const second = await waitFor(() => {
      expect(fakeEpubHandles.length).toBe(2);
      return fakeEpubHandles[1]!;
    });
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    // The first book's engine was superseded mid-open: its host must leave
    // the document immediately (state reset on switch), not linger until
    // the second book's engine arrives.
    expect(first.host.isConnected).toBe(false);

    resolveFirstOpen();
    await waitFor(() => expect(first.close).toHaveBeenCalledTimes(1));
    expect(first.host.isConnected).toBe(false);
    expect(second.host.isConnected).toBe(true);
    expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready");
  });
});

describe("EpubReader appearance and navigation", () => {
  beforeEach(() => {
    fakeEpubHandles.length = 0;
  });

  it("applies the default flow and appearance stylesheet when ready", async () => {
    mockHappyPath(null);

    renderReader();
    const handle = await waitFor(fakeHandleOrThrow);
    await waitFor(() => expect(handle.setFlow).toHaveBeenCalled());
    expect(handle.setFlow).toHaveBeenCalledWith("paginated");
    expect(handle.setAppearance).toHaveBeenCalledWith("css:light:17:1.6");
  });

  it("drives engine page turns from keyboard shortcuts", async () => {
    mockHappyPath(null);

    renderReader();
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    const handle = lastFakeHandle();

    await userEvent.keyboard("{ArrowRight}");
    expect(handle.next).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    expect(handle.next).toHaveBeenCalledTimes(2);
    await userEvent.keyboard("{ArrowLeft}");
    expect(handle.prev).toHaveBeenCalledTimes(1);
  });

  it("jumps to a TOC target through the engine adapter", async () => {
    mockHappyPath(null);
    const adapterRef: { current: ReaderAdapter | null } = { current: null };

    render(
      <ShortcutProvider>
        <ReaderProvider>
          <EpubReader book={makeBookShim()} adapterRef={adapterRef} />
        </ReaderProvider>
      </ShortcutProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    const handle = lastFakeHandle();

    adapterRef.current?.jump({ format: "epub", locator: "chapter2.xhtml" });
    expect(handle.goTo).toHaveBeenCalledWith("chapter2.xhtml");
    // The EPUB adapter ignores other formats' jump targets.
    adapterRef.current?.jump({ format: "pdf", page: 3 });
    expect(handle.goTo).toHaveBeenCalledTimes(1);
  });

  it("reports the tagged engine position from relocate events without feeding position back", async () => {
    mockHappyPath(null);
    const onPositionChange = vi.fn();

    render(
      <ShortcutProvider>
        <ReaderProvider>
          <EpubReader book={makeBookShim()} onPositionChange={onPositionChange} />
        </ReaderProvider>
      </ShortcutProvider>,
    );
    const handle = await waitFor(fakeHandleOrThrow);
    await screen.findByTestId("epub-reader");

    handle.emitRelocate({
      cfi: "epubcfi(/6/4!/4/2,/1:0,/1:42)",
      fraction: 0.55,
      section: { current: 1, total: 2 },
    });
    await waitFor(() => expect(handle.host.dataset.epubState).toBe("ready"));
    expect(handle.host.dataset.epubSection).toBe("1");
    expect(handle.host.dataset.epubFraction).toBe("0.55");
    expect(onPositionChange).toHaveBeenLastCalledWith({
      format: "epub",
      cfi: "epubcfi(/6/4!/4/2,/1:0,/1:42)",
      chapterHref: "chapter2.xhtml",
    });

    // The engine-reported position must not be fed back into the engine
    // (the echo guard skips the section round-trip).
    expect(handle.goTo).not.toHaveBeenCalledWith(1);
  });
});

describe("EpubReader in-book search", () => {
  beforeEach(() => {
    fakeEpubHandles.length = 0;
  });

  interface SearchProps {
    adapterRef?: { current: ReaderAdapter | null };
    onSearchGroup?: (bookId: number, group: unknown) => void;
    onSearchDone?: (bookId: number) => void;
  }

  function renderSearchableReader(props: SearchProps = {}) {
    return render(
      <ShortcutProvider>
        <ReaderProvider>
          <EpubReader
            book={makeBookShim()}
            adapterRef={props.adapterRef}
            onSearchGroup={props.onSearchGroup as never}
            onSearchDone={props.onSearchDone}
          />
        </ReaderProvider>
      </ShortcutProvider>,
    );
  }

  it("runs searches on the engine and streams mapped groups upward", async () => {
    mockHappyPath(null);
    const adapterRef: { current: ReaderAdapter | null } = { current: null };
    const groups: Array<{ label: string; matches: unknown[] }> = [];
    let done = false;
    renderSearchableReader({
      adapterRef,
      onSearchGroup: (_id, group) => groups.push(group as never),
      onSearchDone: () => {
        done = true;
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    const handle = lastFakeHandle();

    adapterRef.current!.search.run("mole");
    await waitFor(() => expect(handle.lastSearchCallbacks).not.toBeNull());
    emitSearchResults(handle, [
      {
        label: "Chapter One",
        subitems: [
          {
            cfi: "epubcfi(/6/2!/4/2,/1:0,/1:8)",
            excerpt: { pre: "The ", match: "mole", post: " was digging" },
          },
        ],
      },
    ]);

    await waitFor(() => expect(done).toBe(true));
    expect(groups).toEqual([
      {
        label: "Chapter One",
        matches: [
          {
            cfi: "epubcfi(/6/2!/4/2,/1:0,/1:8)",
            page: null,
            excerpt: { pre: "The ", match: "mole", post: " was digging" },
          },
        ],
      },
    ]);
  });

  it("labels groups without a chapter name", async () => {
    mockHappyPath(null);
    const adapterRef: { current: ReaderAdapter | null } = { current: null };
    const groups: Array<{ label: string }> = [];
    renderSearchableReader({
      adapterRef,
      onSearchGroup: (_id, group) => groups.push(group as never),
    });
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    const handle = lastFakeHandle();

    adapterRef.current!.search.run("river");
    await waitFor(() => expect(handle.lastSearchCallbacks).not.toBeNull());
    emitSearchResults(handle, [
      { label: "", subitems: [] },
      { label: "", subitems: [] },
    ]);
    expect(groups.map((group) => group.label)).toEqual(["Chapter 1", "Chapter 2"]);
  });

  it("cancels the previous search when a new query runs", async () => {
    mockHappyPath(null);
    const adapterRef: { current: ReaderAdapter | null } = { current: null };
    renderSearchableReader({ adapterRef });
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    const handle = lastFakeHandle();

    adapterRef.current!.search.run("first");
    await waitFor(() => expect(handle.lastSearchCallbacks).not.toBeNull());
    adapterRef.current!.search.run("second");
    expect(handle.searchCancelFns[0]).toHaveBeenCalledTimes(1);
    expect(handle.searchCancelFns).toHaveLength(2);
  });

  it("unregisters the adapter on unmount", async () => {
    mockHappyPath(null);
    const adapterRef: { current: ReaderAdapter | null } = { current: null };
    const { unmount } = renderSearchableReader({ adapterRef });
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    expect(adapterRef.current).not.toBeNull();

    unmount();
    expect(adapterRef.current).toBeNull();
  });
});

function fakeHandleOrThrow() {
  return lastFakeHandle();
}

describe("EpubReader highlights and selection", () => {
  beforeEach(() => {
    fakeEpubHandles.length = 0;
  });

  function renderWithHighlights(
    props: {
      highlights?: Annotation[];
      onCreateHighlight?: (input: Record<string, unknown>) => void;
      onSelectionChange?: (selection: { text: string } | null) => void;
      adapterRef?: { current: ReaderAdapter | null };
    } = {},
  ) {
    mockHappyPath(null);
    return render(
      <ShortcutProvider>
        <ReaderProvider>
          <EpubReader
            book={makeBookShim()}
            highlights={props.highlights}
            onCreateHighlight={props.onCreateHighlight as never}
            onSelectionChange={props.onSelectionChange}
            adapterRef={props.adapterRef}
          />
        </ReaderProvider>
      </ShortcutProvider>,
    );
  }

  it("draws new highlights through the engine and removes deleted ones", async () => {
    const highlights = [
      makeAnnotation({
        id: 1,
        cfi: "epubcfi(/6/2!/4/2,/1:0,/1:4)",
        color: "green",
        pageNumber: null,
        rects: null,
      }),
    ];
    const { rerender } = renderWithHighlights({ highlights });
    const handle = await waitFor(fakeHandleOrThrow);

    await waitFor(() =>
      expect(handle.addHighlight).toHaveBeenCalledWith("epubcfi(/6/2!/4/2,/1:0,/1:4)", "#4ade80"),
    );

    // Recoloring redraws the same CFI with the new color; removing clears it.
    const recolored = [{ ...highlights[0]!, color: "blue" }];
    rerender(
      <ShortcutProvider>
        <ReaderProvider>
          <EpubReader book={makeBookShim()} highlights={recolored} />
        </ReaderProvider>
      </ShortcutProvider>,
    );
    await waitFor(() =>
      expect(handle.addHighlight).toHaveBeenCalledWith("epubcfi(/6/2!/4/2,/1:0,/1:4)", "#60a5fa"),
    );

    rerender(
      <ShortcutProvider>
        <ReaderProvider>
          <EpubReader book={makeBookShim()} highlights={[]} />
        </ReaderProvider>
      </ShortcutProvider>,
    );
    await waitFor(() =>
      expect(handle.removeHighlight).toHaveBeenCalledWith("epubcfi(/6/2!/4/2,/1:0,/1:4)"),
    );
  });

  it("creates a highlight from a section text selection", async () => {
    const onCreateHighlight = vi.fn();
    const onSelectionChange = vi.fn();
    const adapterRef: { current: ReaderAdapter | null } = { current: null };
    renderWithHighlights({ onCreateHighlight, onSelectionChange, adapterRef });
    const handle = await waitFor(fakeHandleOrThrow);
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    // Capture the section document the component's load handler sees.
    const emitted: Document[] = [];
    handle.onLoad(({ doc }) => emitted.push(doc));
    handle.emitLoad({ index: 0, doc: document.implementation.createHTMLDocument() });
    const sectionDoc = emitted[0];
    if (!sectionDoc) throw new Error("no section document emitted");

    // The component stores range.cloneRange(); hand back a marker we can
    // assert on.
    const clonedRange = {} as unknown as Range;
    const fakeRange = { cloneRange: () => clonedRange } as unknown as Range;
    const fakeSelection = {
      isCollapsed: false,
      rangeCount: 1,
      toString: () => "a quoted passage",
      getRangeAt: () => fakeRange,
      removeAllRanges: vi.fn(),
    };
    const selectionSpy = vi
      .spyOn(sectionDoc, "getSelection")
      .mockReturnValue(fakeSelection as unknown as Selection);

    // Selections are captured on pointerup, deferred one tick.
    sectionDoc.dispatchEvent(new Event("pointerup", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(onSelectionChange).toHaveBeenLastCalledWith({ text: "a quoted passage" });

    adapterRef.current!.annotations.createHighlight("yellow");
    expect(handle.getCfiFromRange).toHaveBeenCalledWith(sectionDoc, clonedRange);
    expect(onCreateHighlight).toHaveBeenCalledWith({
      kind: "highlight",
      cfi: "epubcfi(/6/2!/4/2,/1:0,/1:4)",
      chapterHref: "chapter1.xhtml",
      text: "a quoted passage",
      color: "yellow",
    });
    expect(fakeSelection.removeAllRanges).toHaveBeenCalled();
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
    selectionSpy.mockRestore();
  });
});
