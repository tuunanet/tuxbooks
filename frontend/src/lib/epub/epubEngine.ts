import "@/lib/epub/foliate-js/view.js";

/**
 * The single seam between the app and the foliate-js engine, mirroring
 * `lib/pdf/pdfEngine.ts` for PDF.js. Components depend on these re-exported
 * types and on `EpubViewHandle` only — never on the vendored foliate-js
 * sources — so the engine stays swappable and unit tests can mock one module.
 *
 * foliate-js renders EPUB sections in same-origin iframe documents via the
 * `<foliate-view>` custom element. Scripted EPUB content is blocked by the
 * application CSP (`script-src 'self'`); blob: documents inherit it.
 */

import { Overlayer } from "@/lib/epub/foliate-js/overlayer.js";

export const EPUB_MIME_TYPE = "application/epub+zip";

/** Node of the EPUB 2/3 table of contents as reported by the engine. */
export interface EpubTocItem {
  label: string;
  href: string;
  subitems: EpubTocItem[];
}

/** Section position inside the spine, 0-based. */
export interface EpubSectionProgress {
  current: number;
  total: number;
}

/** Payload of the engine's `relocate` event, narrowed to what we persist. */
export interface EpubRelocateDetail {
  /** Canonical EPUB CFI of the reading position (resource + location). */
  cfi: string;
  /**
   * The engine's raw position: in paginated flow this is a page fraction
   * *within the current section* (0..1, or invalid for single-page
   * sections). Use `section` for shell-level progress — byte sizes are not
   * reported by the engine, so section position is the honest coarse measure.
   */
  fraction: number;
  /** Spine position; `section.current + 1 of total`. */
  section: EpubSectionProgress;
  /** Nearest TOC entry at or before the position, when one exists. */
  tocItem: { label: string; href: string } | null;
}

/** Payload of the engine's `load` event (a section document was mounted). */
export interface EpubLoadDetail {
  /** Spine index of the loaded section. */
  index: number;
  /** The mounted section document (same-origin iframe document). */
  doc: Document;
}

/** Surrounding text around one search match. */
export interface EpubSearchExcerpt {
  pre: string;
  match: string;
  post: string;
}

/** One content match: the CFI to jump to plus its excerpt. */
export interface EpubSearchMatch {
  cfi: string;
  excerpt: EpubSearchExcerpt;
}

/** All matches in one section (chapter), as reported by the engine. */
export interface EpubSearchSectionResult {
  label: string;
  subitems: EpubSearchMatch[];
}

/** Streaming callbacks for a whole-book search. */
export interface EpubSearchCallbacks {
  onSection: (section: EpubSearchSectionResult) => void;
  /** Overall progress (0–1) across the spine; optional. */
  onProgress?: (fraction: number) => void;
  /** Always called once the search finishes (success or partial failure). */
  onDone: () => void;
}

/** Reflow layout of the reading surface. */
export type EpubFlow = "paginated" | "scrolled";

/** Visual themes match the reader shell's `ReaderTheme`. */
export type EpubThemeName = "light" | "paper" | "dark";

/** Font stacks offered for user override; null means publisher styles win. */
export const EPUB_FONT_FAMILIES = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: 'system-ui, "Segoe UI", sans-serif',
} as const;
export type EpubFontFamily = keyof typeof EPUB_FONT_FAMILIES;

export interface EpubAppearance {
  fontSize: number;
  lineHeight: number;
  fontFamily: EpubFontFamily | null;
  theme: EpubThemeName;
}

const THEME_COLORS: Record<EpubThemeName, { background: string; text: string; link: string }> = {
  light: { background: "#ffffff", text: "#1f2328", link: "#0b62c4" },
  paper: { background: "#f6f0e4", text: "#3a332a", link: "#7c5b2a" },
  dark: { background: "#101013", text: "#e4e4e7", link: "#7ab7ff" },
};

/**
 * User stylesheet injected into every section document via the engine's
 * `setStyles`. Mirrors the reference reader's CSS (line spacing on text
 * blocks) plus TuxBooks appearance: font size, optional family override, and
 * theme colors. `!important` marks these as deliberate user overrides of
 * publisher styles.
 */
export function epubAppearanceCss(appearance: EpubAppearance): string {
  const colors = THEME_COLORS[appearance.theme];
  const family =
    appearance.fontFamily === null
      ? ""
      : `font-family: ${EPUB_FONT_FAMILIES[appearance.fontFamily]} !important;`;
  return `
    html {
      font-size: ${appearance.fontSize}px !important;
      background: ${colors.background} !important;
      color: ${colors.text} !important;
      ${family}
    }
    a:link { color: ${colors.link} !important; }
    p, li, blockquote, dd {
      line-height: ${appearance.lineHeight};
    }
  `;
}

/** Minimal structural type of the untyped `<foliate-view>` element. */
interface FoliateView extends HTMLElement {
  open(book: unknown): Promise<void>;
  init(options: { lastLocation?: string; showTextStart?: boolean }): Promise<void>;
  close(): void;
  goTo(target: unknown): Promise<unknown>;
  next(distance?: number): Promise<void>;
  prev(distance?: number): Promise<void>;
  renderer: {
    setAttribute(name: string, value: string): void;
    getAttribute(name: string): string | null;
    setStyles?(css: string): void;
    /** One entry per mounted section document (engine-internal shape). */
    getContents?(): { index: number; doc: Document; overlayer?: unknown }[];
  } | null;
  book: {
    toc?: unknown;
    sections?: { id?: unknown }[];
  } | null;
  lastLocation: { fraction?: number } | null;
  search(opts: { query: string }): AsyncGenerator<unknown, void, unknown>;
  clearSearch(): void;
  /** Draws (or removes) one annotation in the engine's section overlays. */
  addAnnotation(annotation: { value: string; color?: string }, remove?: boolean): Promise<unknown>;
  /** Resolves a CFI/href target to its spine index (+ engine anchor). */
  resolveNavigation(target: string): { index: number; anchor: unknown } | undefined;
  /** Canonical `epubcfi(...)` for a range inside section `index`. */
  getCFI(index: number, range: Range): string;
}

/** A highlight drawn into the engine's overlays, kept for section remounts. */
interface EpubHighlight {
  value: string;
  color: string;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

/** Normalizes the engine's loosely-typed TOC tree into `EpubTocItem`s. */
function normalizeToc(node: unknown): EpubTocItem[] {
  if (!Array.isArray(node)) return [];
  return node
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
    .map((item) => ({
      label: asString(item.label),
      href: asString(item.href),
      subitems: normalizeToc(item.subitems),
    }));
}

/** Normalizes one engine search result (`{ cfi, excerpt: {pre,match,post} }`). */
function normalizeSearchMatch(value: unknown): EpubSearchMatch {
  const record =
    value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const excerpt =
    record.excerpt !== null && typeof record.excerpt === "object"
      ? (record.excerpt as Record<string, unknown>)
      : {};
  return {
    cfi: asString(record.cfi),
    excerpt: {
      pre: asString(excerpt.pre),
      match: asString(excerpt.match),
      post: asString(excerpt.post),
    },
  };
}

/**
 * Typed wrapper around one `<foliate-view>` instance. Created per open book
 * by `EpubReader`; owns nothing but the element and the listeners attached
 * through `on*` helpers, whose return values are the unsubscribers.
 */
export class EpubViewHandle {
  private readonly view: FoliateView;
  private searchGeneration = 0;
  private activeSearchIterator: AsyncGenerator<unknown, void, unknown> | null = null;
  /** All live highlights, by spine index, for `create-overlay` remounts. */
  private readonly highlightsByIndex = new Map<number, EpubHighlight[]>();

  private constructor(element: HTMLDivElement) {
    this.view = element.querySelector("foliate-view") as FoliateView;
    if (!this.view) throw new Error("foliate-view element missing from host");
    // The engine asks the host how to draw every annotation; highlights are
    // translucent marks in the annotation's color. The paginator redraws
    // overlays on reflow, and `create-overlay` remounts one per section —
    // this subscription re-adds that section's highlights.
    this.view.addEventListener("draw-annotation", ((event: CustomEvent) => {
      const { draw, annotation } = event.detail ?? {};
      if (typeof draw === "function") draw(Overlayer.highlight, { color: annotation?.color });
    }) as EventListener);
    this.view.addEventListener("create-overlay", ((event: CustomEvent) => {
      const index = Number(event.detail?.index);
      for (const highlight of this.highlightsByIndex.get(index) ?? []) {
        void this.view.addAnnotation(highlight);
      }
    }) as EventListener);
  }

  /** Creates the host + `<foliate-view>` element pair. Not yet holding a book. */
  static create(): { host: HTMLDivElement; handle: EpubViewHandle } {
    const host = document.createElement("div");
    host.setAttribute("data-epub-host", "");
    const view = document.createElement("foliate-view");
    // The engine's shadow paginator sizes itself to 100% of its host chain,
    // which must therefore be an explicit block chain (the reference reader
    // does the same for `foliate-view`).
    view.style.display = "block";
    view.style.width = "100%";
    view.style.height = "100%";
    host.style.width = "100%";
    host.style.height = "100%";
    host.appendChild(view);
    return { host, handle: new EpubViewHandle(host) };
  }

  /** The element React mounts; the `<foliate-view>` lives inside it. */
  get host(): HTMLDivElement {
    return this.view.parentElement as HTMLDivElement;
  }

  /**
   * Parses the EPUB from raw bytes and mounts the renderer. Accepts an
   * ArrayBuffer or a plain number array (the postMessage IPC fallback
   * JSON-serializes raw byte responses); both are wrapped into a File —
   * a File, not a Blob, because the engine sniffs the payload by file
   * extension (`name.endsWith`), which a nameless Blob does not provide.
   */
  async open(data: ArrayBuffer | number[]): Promise<void> {
    const part = data instanceof ArrayBuffer ? data : Uint8Array.from(data);
    const file = new File([part], "book.epub", { type: EPUB_MIME_TYPE });
    await this.view.open(file);
  }

  /**
   * Moves to the restored location (a stored CFI) or the start of the book.
   * Must run after {@link open}; the first `relocate` follows it.
   */
  async init(lastLocation: string | null): Promise<void> {
    await this.view.init({ lastLocation: lastLocation ?? undefined });
  }

  /** TOC tree of the opened book, or null before `open` resolves. */
  getToc(): EpubTocItem[] {
    return normalizeToc(this.view.book?.toc);
  }

  /** Spine href of the current section (`chapter_href` for persistence). */
  getSectionHref(index: number): string | null {
    const id = this.view.book?.sections?.[index]?.id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }

  /**
   * Whole-book search over actual EPUB content via the engine's matcher.
   * Results stream in per section through `callbacks` (the engine walks the
   * spine asynchronously) and every match is drawn into the rendered pages
   * by the engine's overlayer until the next search or `clearSearch`.
   *
   * Starting a new search supersedes a running one: the previous iteration
   * is stopped and its callbacks never fire again. Returns a cancel
   * function that does the same on demand.
   */
  search(query: string, callbacks: EpubSearchCallbacks): () => void {
    const generation = ++this.searchGeneration;
    this.activeSearchIterator?.return(undefined);
    this.view.clearSearch();
    const iterator = this.view.search({ query });
    this.activeSearchIterator = iterator;
    void this.consumeSearch(iterator, generation, callbacks).finally(() => {
      if (this.activeSearchIterator === iterator) this.activeSearchIterator = null;
    });
    return () => {
      void iterator.return(undefined);
    };
  }

  private async consumeSearch(
    iterator: AsyncGenerator<unknown, void, unknown>,
    generation: number,
    callbacks: EpubSearchCallbacks,
  ): Promise<void> {
    try {
      for await (const raw of iterator) {
        if (generation !== this.searchGeneration) return;
        if (raw === "done" || raw === null || typeof raw !== "object") continue;
        const result = raw as Record<string, unknown>;
        // Whole-book searches interleave `{ progress }` heartbeat items.
        if (typeof result.progress === "number" && result.subitems === undefined) {
          callbacks.onProgress?.(result.progress);
          continue;
        }
        if (Array.isArray(result.subitems)) {
          callbacks.onSection({
            label: asString(result.label),
            subitems: result.subitems.map(normalizeSearchMatch),
          });
        }
      }
    } catch (error) {
      // A section that fails to parse ends the iteration early; the UI
      // contract only requires that the search eventually reports done.
      console.warn("epub search ended with an error:", error);
    }
    if (generation === this.searchGeneration) callbacks.onDone();
  }

  /** Removes all match highlights from the rendered pages. */
  clearSearch(): void {
    this.searchGeneration += 1;
    this.activeSearchIterator?.return(undefined);
    this.activeSearchIterator = null;
    this.view.clearSearch();
  }

  /**
   * Draws a highlight at `cfi` and keeps it for section remounts. The
   * engine draws immediately when the section is mounted; otherwise the
   * `create-overlay` subscription re-adds it when the section arrives.
   */
  addHighlight(cfi: string, color: string): void {
    this.forgetHighlight(cfi);
    const resolved = this.view.resolveNavigation(cfi);
    if (resolved && Number.isFinite(resolved.index)) {
      const list = this.highlightsByIndex.get(resolved.index) ?? [];
      list.push({ value: cfi, color });
      this.highlightsByIndex.set(resolved.index, list);
    }
    void this.view.addAnnotation({ value: cfi, color });
  }

  /** Removes a highlight from the overlays and the remount bookkeeping. */
  removeHighlight(cfi: string): void {
    this.forgetHighlight(cfi);
    void this.view.addAnnotation({ value: cfi }, true);
  }

  private forgetHighlight(cfi: string): void {
    for (const [index, list] of this.highlightsByIndex) {
      const next = list.filter((highlight) => highlight.value !== cfi);
      if (next.length === list.length) continue;
      if (next.length === 0) this.highlightsByIndex.delete(index);
      else this.highlightsByIndex.set(index, next);
    }
  }

  /**
   * Canonical `epubcfi(...)` for a range inside a mounted section document,
   * plus that section's spine href. Null when the document is not a mounted
   * section (never expected for selections captured through `onLoad`).
   */
  getCfiFromRange(doc: Document, range: Range): { cfi: string; href: string | null } | null {
    const contents = this.view.renderer?.getContents?.() ?? [];
    const entry = contents.find((candidate) => candidate.doc === doc);
    if (!entry) return null;
    const cfi = this.view.getCFI(entry.index, range);
    return { cfi, href: this.getSectionHref(entry.index) };
  }

  onRelocate(handler: (detail: EpubRelocateDetail) => void): () => void {
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail ?? {};
      handler({
        cfi: asString(detail.cfi),
        fraction: Number(detail.fraction) || 0,
        section: {
          current: Number((detail.section as Record<string, unknown> | undefined)?.current) || 0,
          total: Number((detail.section as Record<string, unknown> | undefined)?.total) || 0,
        },
        tocItem:
          detail.tocItem && typeof detail.tocItem === "object"
            ? {
                label: asString((detail.tocItem as Record<string, unknown>).label),
                href: asString((detail.tocItem as Record<string, unknown>).href),
              }
            : null,
      });
    };
    this.view.addEventListener("relocate", listener);
    return () => this.view.removeEventListener("relocate", listener);
  }

  onLoad(handler: (detail: EpubLoadDetail) => void): () => void {
    const listener = (event: Event): void => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail ?? {};
      // Realm-safe document check: the engine hands over the iframe's
      // contentDocument, whose Document constructor belongs to the iframe
      // realm, so `instanceof Document` would wrongly fail here.
      const doc = detail.doc as Document | null;
      handler({
        index: Number(detail.index) || 0,
        doc: doc && doc.nodeType === 9 ? doc : new Document(),
      });
    };
    this.view.addEventListener("load", listener);
    return () => this.view.removeEventListener("load", listener);
  }

  /**
   * Blocks the engine's default `window.open` for external links and reports
   * them instead; a Tauri desktop app must not navigate the reading surface
   * to the web. Returns the unsubscriber.
   */
  onExternalLink(handler: (href: string) => void): () => void {
    const listener = (event: Event): void => {
      event.preventDefault();
      const detail = (event as CustomEvent<Record<string, unknown>>).detail ?? {};
      handler(asString(detail.href_));
    };
    this.view.addEventListener("external-link", listener);
    return () => this.view.removeEventListener("external-link", listener);
  }

  goTo(target: string | number): Promise<unknown> {
    return this.view.goTo(target);
  }

  next(): Promise<void> {
    return this.view.next();
  }

  prev(): Promise<void> {
    return this.view.prev();
  }

  /** Applies the reflow layout; no-op before the renderer exists. */
  setFlow(flow: EpubFlow): void {
    this.view.renderer?.setAttribute("flow", flow === "scrolled" ? "scrolled" : "paginated");
  }

  /** Injects the user appearance stylesheet; no-op before the renderer exists. */
  setAppearance(css: string): void {
    this.view.renderer?.setStyles?.(css);
  }

  /**
   * Re-runs the paginator layout. WebKit resolves `fonts.ready` early while
   * section fonts are still settling, and the paginator's deferred re-expand
   * can then measure a zero-size document and collapse the section to zero
   * width (blank reader). Calling this once fonts have settled re-measures
   * with real geometry; no-op before the renderer exists.
   */
  relayout(): void {
    const renderer = this.view.renderer as { render?: () => void } | null;
    renderer?.render?.();
  }

  /** Current overall progression (0–1), for bootstrapping shell state. */
  getFraction(): number {
    return this.view.lastLocation?.fraction ?? 0;
  }

  /** Destroys the renderer and frees the book. */
  close(): void {
    this.view.close();
  }
}
