import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Mock } from "vitest";

vi.mock("@/lib/epub/readiumEngine", async () => {
  const { makeFakeReadiumModule } = await import("./mocks/readiumEngine");
  return makeFakeReadiumModule();
});

import { EpubReader } from "@/components/reader/EpubReader";
import { ReadiumEpubHandle } from "@/lib/epub/readiumEngine";
import { epubHrefJump, type ReaderAdapter } from "@/components/reader/readerModel";
import { ShortcutProvider } from "@/state/ShortcutProvider";
import { ReaderProvider } from "@/state/ReaderProvider";
import { useReader, type ReaderPreferences } from "@/state/readerState";
import { mockInvoke } from "./mocks/bridge";
import {
  createFakeHandle,
  emitSearchResults,
  fakeEpubHandles,
  lastFakeHandle,
  FAKE_LOCATOR,
} from "./mocks/readiumEngine";
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
  locator: null,
  progression: null,
  locations: null,
  engine: null,
  schemaVersion: null,
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function renderReader(props: { onTocLoad?: (toc: unknown[]) => void; bookId?: number } = {}) {
  const view = render(
    <ShortcutProvider>
      <ReaderProvider>
        <EpubReader
          key={props.bookId ?? 1}
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
            <EpubReader
              key={bookId}
              book={{ ...makeBookShim(), id: bookId }}
              onTocLoad={props.onTocLoad}
            />
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
    progressPercent: null,
    progressUpdatedAt: null,
  };
}

function mockHappyPath(saved: typeof SAVED_PROGRESS | null) {
  mockInvoke({
    get_reading_progress: saved,
    save_reading_progress: null,
  });
}

/**
 * The mocked engine's static open (the async boundary `useEpubDocument`
 * awaits). Handles it creates land in `fakeEpubHandles`.
 */
function engineOpen(): Mock {
  return (ReadiumEpubHandle as unknown as { open: Mock }).open;
}

/**
 * Button that patches reader preferences through the real provider state —
 * event-driven, so tests never setState synchronously inside effects.
 */
function PreferenceProbe({ label, patch }: { label: string; patch: Partial<ReaderPreferences> }) {
  const { setPreferences } = useReader();
  return (
    <button type="button" onClick={() => setPreferences(patch)}>
      {label}
    </button>
  );
}

function renderReaderWithProbe(label: string, patch: Partial<ReaderPreferences>) {
  render(
    <ShortcutProvider>
      <ReaderProvider>
        <PreferenceProbe label={label} patch={patch} />
        <EpubReader book={makeBookShim()} />
      </ReaderProvider>
    </ShortcutProvider>,
  );
}

async function clickProbe(label: string): Promise<void> {
  await userEvent.click(screen.getByRole("button", { name: label }));
}

describe("EpubReader lifecycle", () => {
  beforeEach(() => {
    fakeEpubHandles.length = 0;
    engineOpen().mockClear();
  });

  it("opens the publication, mounts the engine host, and becomes ready", async () => {
    mockHappyPath(null);
    const onTocLoad = vi.fn();

    renderReader({ onTocLoad });
    expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "loading");
    expect(screen.getByTestId("epub-loading")).toBeInTheDocument();

    await waitFor(fakeHandleOrThrow);
    expect(engineOpen()).toHaveBeenCalledWith(1);
    const handle = lastFakeHandle();
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    expect(handle.init).toHaveBeenCalledWith(null);
    expect(handle.hostElement.isConnected).toBe(true);
    expect(onTocLoad).toHaveBeenCalledWith([
      { label: "Chapter One", href: "chapter1.xhtml", subitems: [] },
      { label: "Chapter Two", href: "chapter2.xhtml", subitems: [] },
    ]);
  });

  it("restores the saved record through engine init (the seam migrates foliate rows)", async () => {
    mockHappyPath(SAVED_PROGRESS);

    renderReader();
    await waitFor(fakeHandleOrThrow);
    const handle = lastFakeHandle();
    await waitFor(() => expect(handle.init).toHaveBeenCalled());
    expect(handle.init).toHaveBeenCalledWith(SAVED_PROGRESS);
    expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready");
  });

  it("renders an honest error when the session cannot be opened", async () => {
    mockInvoke({
      get_reading_progress: null,
      save_reading_progress: null,
    });
    engineOpen().mockRejectedValueOnce(new Error("session failed"));

    renderReader();
    expect(await screen.findByTestId("epub-error")).toHaveTextContent(
      "This EPUB could not be opened: session failed",
    );
  });

  it("closes the engine when the reader unmounts", async () => {
    mockHappyPath(null);
    const { unmount } = renderReader();
    await waitFor(fakeHandleOrThrow);
    const handle = lastFakeHandle();
    await screen.findByTestId("epub-reader");

    unmount();
    await waitFor(() => expect(handle.close).toHaveBeenCalledTimes(1));
    expect(handle.hostElement.isConnected).toBe(false);
  });

  it("closes the previous engine and mounts a fresh one when the book changes", async () => {
    mockHappyPath(null);

    const view = renderReader({ bookId: 1 });
    await waitFor(fakeHandleOrThrow);
    const first = lastFakeHandle();
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    expect(first.hostElement.isConnected).toBe(true);

    view.rerenderBook(2);
    await waitFor(() => expect(fakeEpubHandles.length).toBe(2));
    const second = fakeEpubHandles[1]!;
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    // The old engine is closed and its host is detached; the new book's
    // host is the one connected to the document.
    await waitFor(() => expect(first.close).toHaveBeenCalledTimes(1));
    expect(first.hostElement.isConnected).toBe(false);
    expect(second.init).toHaveBeenCalledTimes(1);
    expect(second.hostElement.isConnected).toBe(true);
  });

  it("closes an open that finishes after the book changed", async () => {
    mockHappyPath(null);

    let resolveFirstOpen: (handle: unknown) => void = () => {};
    engineOpen().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstOpen = resolve;
        }),
    );

    const view = renderReader({ bookId: 1 });
    view.rerenderBook(2);
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    const second = lastFakeHandle();

    // The first book's engine was superseded mid-open: its gated open, once
    // resolved, closes the orphaned handle instead of mounting it, and the
    // second book's reader is untouched.
    const orphan = createFakeHandle();
    expect(orphan.hostElement.isConnected).toBe(false);
    resolveFirstOpen(orphan);
    await waitFor(() => expect(orphan.close).toHaveBeenCalledTimes(1));
    expect(second.close).not.toHaveBeenCalled();
    expect(second.hostElement.isConnected).toBe(true);
    expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready");
  });
});

describe("EpubReader appearance and navigation", () => {
  beforeEach(() => {
    fakeEpubHandles.length = 0;
  });

  it("applies the default flow and appearance through the engine preferences", async () => {
    mockHappyPath(null);

    renderReader();
    await waitFor(fakeHandleOrThrow);
    const handle = lastFakeHandle();
    await waitFor(() => expect(handle.setFlow).toHaveBeenCalled());
    expect(handle.setFlow).toHaveBeenCalledWith("paginated");
    expect(handle.setAppearance).toHaveBeenCalledWith({
      fontSize: 17,
      lineHeight: 1.6,
      fontFamily: null,
      theme: "light",
    });
  });

  it("leaves the paginated reading surface uncapped (engine grid bounds it)", async () => {
    mockHappyPath(null);

    renderReader();
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    const surface = screen.getByTestId("epub-reader").querySelector("[data-epub-measure]");
    expect(surface).not.toBeNull();
    expect(surface).toHaveAttribute("data-epub-measure", "full");
    // No app-side width cap in paginated flow — the engine's grid already
    // bounds the section iframe (~two 720px columns).
    expect((surface as HTMLElement).style.maxWidth).toBe("");
  });

  it("caps and centers the scrolled reading surface at the seam constant", async () => {
    mockHappyPath(null);

    renderReaderWithProbe("probe-scrolling", { layout: "scrolling" });
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );
    await clickProbe("probe-scrolling");

    const surface = screen.getByTestId("epub-reader").querySelector("[data-epub-measure]")!;
    expect(surface).toHaveAttribute("data-epub-measure", "capped");
    expect((surface as HTMLElement).style.maxWidth).toBe("777px");
    expect((surface as HTMLElement).style.marginInline).toBe("auto");
  });

  it("bridges the engine theme background on the reader root", async () => {
    mockHappyPath(null);

    renderReaderWithProbe("probe-paper", { theme: "paper" });
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    // Root background follows the engine's theme colors (mocked here) so
    // the shell area beside the capped column is seamless.
    expect(screen.getByTestId("epub-reader").style.backgroundColor).toBe("rgb(254, 254, 254)");
    await clickProbe("probe-paper");
    expect(screen.getByTestId("epub-reader").style.backgroundColor).toBe("rgb(246, 240, 228)");
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

    const tocJump = epubHrefJump("chapter2.xhtml");
    adapterRef.current?.jump(tocJump);
    expect(handle.goTo).toHaveBeenCalledWith(JSON.stringify({ href: "chapter2.xhtml" }));
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
    await waitFor(fakeHandleOrThrow);
    const handle = lastFakeHandle();
    await screen.findByTestId("epub-reader");

    handle.emitRelocate({
      locator: FAKE_LOCATOR.section2,
      fraction: 0.55,
      section: { current: 1, total: 2 },
      totalProgression: 0.55,
    });
    await waitFor(() => expect(handle.hostElement.dataset.epubState).toBe("ready"));
    expect(handle.hostElement.dataset.epubSection).toBe("1");
    expect(handle.hostElement.dataset.epubFraction).toBe("0.55");
    expect(handle.hostElement.dataset.epubLocator).toBe(FAKE_LOCATOR.section2);
    expect(onPositionChange).toHaveBeenLastCalledWith({
      format: "epub",
      locator: FAKE_LOCATOR.section2,
      chapterHref: "chapter2.xhtml",
    });

    // The engine-reported position must not be fed back into the engine
    // (the echo guard skips the position round-trip).
    expect(handle.goTo).not.toHaveBeenCalled();
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
            locator: FAKE_LOCATOR.section1,
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
            locator: FAKE_LOCATOR.section1,
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
  lastFakeHandle();
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
        cfi: FAKE_LOCATOR.section1,
        color: "green",
        pageNumber: null,
        rects: null,
      }),
    ];
    const { rerender } = renderWithHighlights({ highlights });
    await waitFor(fakeHandleOrThrow);
    const handle = lastFakeHandle();

    await waitFor(() =>
      expect(handle.addHighlight).toHaveBeenCalledWith(FAKE_LOCATOR.section1, "#4ade80"),
    );

    // Recoloring redraws the same locator with the new color; removing clears it.
    const recolored = [{ ...highlights[0]!, color: "blue" }];
    rerender(
      <ShortcutProvider>
        <ReaderProvider>
          <EpubReader book={makeBookShim()} highlights={recolored} />
        </ReaderProvider>
      </ShortcutProvider>,
    );
    await waitFor(() =>
      expect(handle.addHighlight).toHaveBeenCalledWith(FAKE_LOCATOR.section1, "#60a5fa"),
    );

    rerender(
      <ShortcutProvider>
        <ReaderProvider>
          <EpubReader book={makeBookShim()} highlights={[]} />
        </ReaderProvider>
      </ShortcutProvider>,
    );
    await waitFor(() => expect(handle.removeHighlight).toHaveBeenCalledWith(FAKE_LOCATOR.section1));
  });

  it("creates a highlight from a selection the engine reports", async () => {
    const onCreateHighlight = vi.fn();
    const onSelectionChange = vi.fn();
    const adapterRef: { current: ReaderAdapter | null } = { current: null };
    renderWithHighlights({ onCreateHighlight, onSelectionChange, adapterRef });
    await waitFor(fakeHandleOrThrow);
    const handle = lastFakeHandle();
    await waitFor(() =>
      expect(screen.getByTestId("epub-reader")).toHaveAttribute("data-epub-state", "ready"),
    );

    // The engine reports the selection text; the shell surfaces it. EPUB
    // selections never target an existing highlight from the toolbar.
    handle.emitSelection("a quoted passage");
    await waitFor(() =>
      expect(onSelectionChange).toHaveBeenLastCalledWith({
        text: "a quoted passage",
        highlightId: null,
      }),
    );

    adapterRef.current!.annotations.createHighlight("yellow");
    expect(onCreateHighlight).toHaveBeenCalledWith({
      kind: "highlight",
      cfi: FAKE_LOCATOR.selection,
      chapterHref: "chapter1.xhtml",
      text: "a quoted passage",
      color: "yellow",
    });
    // The selection is cleared on creation (engine + shell state).
    expect(handle.clearSelection).toHaveBeenCalledTimes(1);
    expect(onSelectionChange).toHaveBeenLastCalledWith(null);
  });
});
