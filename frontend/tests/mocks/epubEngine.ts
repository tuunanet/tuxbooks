import { vi } from "vitest";

/**
 * Fake of the `@/lib/epub/epubEngine` surface for unit tests. Test files must
 * hoist `vi.mock("@/lib/epub/epubEngine", ...)` themselves (vitest hoists
 * mocks above imports); the factory imports this module and spreads
 * `makeFakeEpubModule()`. Created handles land in `fakeEpubHandles` so tests
 * can drive the engine (emit relocate, inspect calls) from outside.
 */
import type { EpubRelocateDetail, EpubTocItem } from "@/lib/epub/epubEngine";

export interface FakeEpubHandle {
  host: HTMLDivElement;
  open: ReturnType<typeof vi.fn>;
  init: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  goTo: ReturnType<typeof vi.fn>;
  next: ReturnType<typeof vi.fn>;
  prev: ReturnType<typeof vi.fn>;
  setFlow: ReturnType<typeof vi.fn>;
  setAppearance: ReturnType<typeof vi.fn>;
  relayout: ReturnType<typeof vi.fn>;
  getToc: ReturnType<typeof vi.fn>;
  getSectionHref: ReturnType<typeof vi.fn>;
  getFraction: ReturnType<typeof vi.fn>;
  onRelocate: (fn: (detail: EpubRelocateDetail) => void) => () => void;
  onLoad: (fn: (detail: { index: number; doc: Document }) => void) => () => void;
  onExternalLink: (fn: (href: string) => void) => () => void;
  emitRelocate: (detail: Partial<EpubRelocateDetail>) => void;
  emitLoad: (detail?: { index: number; doc?: Document }) => void;
}

function makeFakeHandle(toc: EpubTocItem[]): FakeEpubHandle {
  const relocateListeners = new Set<(detail: EpubRelocateDetail) => void>();
  const loadListeners = new Set<(detail: { index: number; doc: Document }) => void>();
  const externalListeners = new Set<(href: string) => void>();
  const unsub =
    <T>(set: Set<T>, fn: T) =>
    () =>
      set.delete(fn);

  const handle = {
    host: document.createElement("div"),
    open: vi.fn(async () => {}),
    init: vi.fn(async () => {}),
    close: vi.fn(),
    goTo: vi.fn(async () => {}),
    next: vi.fn(async () => {}),
    prev: vi.fn(async () => {}),
    setFlow: vi.fn(),
    setAppearance: vi.fn(),
    relayout: vi.fn(),
    getToc: vi.fn(() => toc),
    getSectionHref: vi.fn((index: number) => `chapter${index + 1}.xhtml`),
    getFraction: vi.fn(() => 0),
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
    emitRelocate: (detail: Partial<EpubRelocateDetail>) => {
      const full: EpubRelocateDetail = {
        cfi: "epubcfi(/6/2!/4/2,/1:0,/1:10)",
        fraction: 0,
        section: { current: 0, total: 2 },
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

/** Latest handle created by the engine, or undefined before any open. */
export function lastFakeHandle(): FakeEpubHandle {
  const handle = fakeEpubHandles[fakeEpubHandles.length - 1];
  if (!handle) throw new Error("no fake epub handle created");
  return handle;
}

/** The module shape installed by the `vi.mock` factory in test files. */
export function makeFakeEpubModule() {
  class FakeEpubViewHandle {
    static create(): { host: HTMLDivElement; handle: FakeEpubHandle } {
      const handle = makeFakeHandle(fakeEpubToc);
      fakeEpubHandles.push(handle);
      return { host: handle.host, handle };
    }
  }
  return {
    EPUB_MIME_TYPE: "application/epub+zip",
    EPUB_FONT_FAMILIES: { serif: "serif-stack", sans: "sans-stack" },
    epubAppearanceCss: vi.fn(
      (appearance: { fontSize: number; lineHeight: number; theme: string }) =>
        `css:${appearance.theme}:${appearance.fontSize}:${appearance.lineHeight}`,
    ),
    EpubViewHandle: FakeEpubViewHandle,
  };
}
