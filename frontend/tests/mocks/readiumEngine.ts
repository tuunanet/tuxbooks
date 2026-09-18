import { vi } from "vitest";

/**
 * Fake of the `@/lib/epub/readiumEngine` surface for unit tests. Test files
 * must hoist `vi.mock("@/lib/epub/readiumEngine", ...)` themselves (vitest
 * hoists mocks above imports); the factory imports this module and spreads
 * `makeFakeReadiumModule()`. Created handles land in `fakeEpubHandles` so
 * tests can drive the engine (emit relocate, inspect calls) from outside.
 */
import type {
  EpubRelocateDetail,
  EpubSearchCallbacks,
  EpubTocItem,
} from "@/lib/epub/readiumEngine";

export const FAKE_LOCATOR = {
  section1:
    '{"href":"chapter1.xhtml","type":"application/xhtml+xml","locations":{"progression":0.1}}',
  section2:
    '{"href":"chapter2.xhtml","type":"application/xhtml+xml","locations":{"progression":0.55}}',
  selection:
    '{"href":"chapter1.xhtml","type":"application/xhtml+xml","locations":{},"text":{"highlight":"a quoted passage"}}',
};

export interface FakeEpubHandle {
  hostElement: HTMLDivElement;
  init: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  goTo: ReturnType<typeof vi.fn>;
  goToTotalProgression: ReturnType<typeof vi.fn>;
  next: ReturnType<typeof vi.fn>;
  prev: ReturnType<typeof vi.fn>;
  setFlow: ReturnType<typeof vi.fn>;
  setAppearance: ReturnType<typeof vi.fn>;
  getToc: ReturnType<typeof vi.fn>;
  getSectionHref: ReturnType<typeof vi.fn>;
  getFraction: ReturnType<typeof vi.fn>;
  addHighlight: ReturnType<typeof vi.fn>;
  removeHighlight: ReturnType<typeof vi.fn>;
  clearSelection: ReturnType<typeof vi.fn>;
  getLocatorFromSelection: ReturnType<typeof vi.fn>;
  search: (query: string, callbacks: EpubSearchCallbacks) => ReturnType<typeof vi.fn>;
  clearSearch: ReturnType<typeof vi.fn>;
  /** Callbacks from the most recent search call, for driving matches. */
  lastSearchCallbacks: EpubSearchCallbacks | null;
  /** Cancel functions returned by each search call, in call order. */
  searchCancelFns: Array<ReturnType<typeof vi.fn>>;
  onRelocate: (fn: (detail: EpubRelocateDetail) => void) => () => void;
  onLoad: (fn: (detail: { index: number; doc: Document }) => void) => () => void;
  onExternalLink: (fn: (href: string) => void) => () => void;
  onSelection: (fn: (selection: { text: string }) => void) => () => void;
  emitRelocate: (detail: Partial<EpubRelocateDetail>) => void;
  emitLoad: (detail?: { index: number; doc?: Document }) => void;
  emitSelection: (text: string) => void;
}

function makeFakeHandle(toc: EpubTocItem[]): FakeEpubHandle {
  const relocateListeners = new Set<(detail: EpubRelocateDetail) => void>();
  const loadListeners = new Set<(detail: { index: number; doc: Document }) => void>();
  const externalListeners = new Set<(href: string) => void>();
  const selectionListeners = new Set<(selection: { text: string }) => void>();
  const unsub =
    <T>(set: Set<T>, fn: T) =>
    () =>
      set.delete(fn);

  const handle = {
    hostElement: document.createElement("div"),
    init: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    goTo: vi.fn(async () => {}),
    goToTotalProgression: vi.fn(async () => {}),
    next: vi.fn(async () => {}),
    prev: vi.fn(async () => {}),
    setFlow: vi.fn(async () => {}),
    setAppearance: vi.fn(async () => {}),
    getToc: vi.fn(() => toc),
    getSectionHref: vi.fn(
      (index: number) => (toc[index]?.href ?? `chapter${index + 1}.xhtml`.split("#")[0]) as string,
    ),
    getFraction: vi.fn(() => 0),
    addHighlight: vi.fn(),
    removeHighlight: vi.fn(),
    clearSelection: vi.fn(),
    getLocatorFromSelection: vi.fn(() => ({
      locator: FAKE_LOCATOR.selection,
      href: "chapter1.xhtml",
      text: "a quoted passage",
    })),
    clearSearch: vi.fn(),
    lastSearchCallbacks: null as EpubSearchCallbacks | null,
    searchCancelFns: [] as Array<ReturnType<typeof vi.fn>>,
    search: (_query: string, callbacks: EpubSearchCallbacks) => {
      handle.lastSearchCallbacks = callbacks;
      const cancel = vi.fn();
      handle.searchCancelFns.push(cancel);
      return cancel;
    },
    onRelocate: (fn: (detail: EpubRelocateDetail) => void) => {
      relocateListeners.add(fn);
      return unsub(relocateListeners, fn);
    },
    onLoad: (fn: (detail: { index: number; doc: Document }) => void) => {
      loadListeners.add(fn);
      return unsub(loadListeners, fn);
    },
    onExternalLink: (fn: (href: string) => void) => {
      externalListeners.add(fn);
      return unsub(externalListeners, fn);
    },
    onSelection: (fn: (selection: { text: string }) => void) => {
      selectionListeners.add(fn);
      return unsub(selectionListeners, fn);
    },
    emitRelocate: (detail: Partial<EpubRelocateDetail>) => {
      const full: EpubRelocateDetail = {
        locator: FAKE_LOCATOR.section1,
        fraction: 0,
        section: { current: 0, total: 2 },
        totalProgression: 0,
        tocItem: null,
        ...detail,
      };
      for (const listener of [...relocateListeners]) listener(full);
    },
    emitLoad: (detail: { index?: number; doc?: Document } = {}) => {
      for (const listener of [...loadListeners]) {
        listener({
          index: 0,
          doc: document.implementation.createHTMLDocument(),
          ...detail,
        });
      }
    },
    emitSelection: (text: string) => {
      for (const listener of [...selectionListeners]) listener({ text });
    },
  };
  return handle;
}

/** All handles created since the last `fakeEpubHandles.length = 0`. */
export const fakeEpubHandles: FakeEpubHandle[] = [];

/** Default TOC served by fake handles; override per test via mockReturnValue. */
export const fakeEpubToc: EpubTocItem[] = [
  { label: "Chapter One", href: "chapter1.xhtml", subitems: [] },
  { label: "Chapter Two", href: "chapter2.xhtml", subitems: [] },
];

/** A handle outside the open() flow, for superseded-open test scenarios. */
export function createFakeHandle(): FakeEpubHandle {
  const handle = makeFakeHandle(fakeEpubToc);
  fakeEpubHandles.push(handle);
  return handle;
}

/** Latest handle created by the engine, or undefined before any open. */
export function lastFakeHandle(): FakeEpubHandle {
  const handle = fakeEpubHandles[fakeEpubHandles.length - 1];
  if (!handle) throw new Error("no fake epub handle created");
  return handle;
}

/** Flush the search callbacks the last run seeded: section → done. */
export function emitSearchResults(
  handle: FakeEpubHandle,
  sections: Parameters<EpubSearchCallbacks["onSection"]>[0][],
): void {
  for (const section of sections) handle.lastSearchCallbacks?.onSection(section);
  handle.lastSearchCallbacks?.onDone();
}

/** The module shape installed by the `vi.mock` factory in test files. */
export function makeFakeReadiumModule() {
  return {
    EPUB_MIME_TYPE: "application/epub+zip",
    EPUB_FONT_FAMILIES: { serif: "serif-stack", sans: "sans-stack" },
    EPUB_SCROLLED_SURFACE_MAX_PX: 777,
    // Valid CSS colors: jsdom validates longhand values and drops duds.
    // The neutral default bridges nothing (undefined, no inline style).
    epubThemeBackground: vi.fn(
      (theme: string) =>
        ({
          default: undefined,
          light: "#fefefe",
          paper: "#f6f0e4",
          dark: "#0e0e10",
          contrast: "#000000",
          "blue-contrast": "#181842",
          "mint-contrast": "#c5e7cd",
        })[theme],
    ),
    serializeLocator: vi.fn((locator: unknown) => JSON.stringify(locator)),
    ReadiumEpubHandle: Object.assign(
      vi.fn().mockImplementation(() => {
        throw new Error("use ReadiumEpubHandle.open in tests");
      }),
      {
        open: vi.fn(async () => {
          const handle = makeFakeHandle(fakeEpubToc);
          fakeEpubHandles.push(handle);
          return handle;
        }),
      },
    ),
  };
}
