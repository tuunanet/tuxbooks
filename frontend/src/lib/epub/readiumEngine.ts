/**
 * The single seam between the app and the Readium toolkit (`@readium/*`),
 * successor of the old foliate `lib/epub/epubEngine.ts` (docs/epub.md).
 * Components depend on these re-exported types and on `ReadiumEpubHandle`
 * only — never on Readium objects — so the engine stays swappable and unit
 * tests can mock one module.
 *
 * Publication model: the Rust session layer (`epub/session.rs`) parses the
 * stored EPUB into a Readium webpub manifest + positions list, served
 * through `get_epub_session` (JSON-RPC); every document/image/stylesheet
 * the navigator touches loads per-resource over the `tuxbooks://` protocol
 * (the renderer never touches ZIP archives — docs/architecture.md).
 *
 * Locator grammar: the app-level EPUB locator is the serialized Readium
 * `Locator` JSON. Legacy foliate CFIs (progress rows, stored annotations)
 * convert through `lib/epub/progressMigration.ts` at restore/jump time.
 *
 * Content renders in same-origin sandboxed iframes (blob: URLs built by the
 * navigator); scripted EPUB content is blocked by the application CSP, and
 * external links are intercepted by `handleLocator`, never navigated.
 */

import { HttpFetcher, Link, Locator, Manifest, Publication } from "@readium/shared";
import { EpubNavigator, EpubPreferences } from "@readium/navigator";
import type { Decoration } from "@readium/decorator";
import type { BasicTextSelection } from "@readium/navigator-html-injectables";

import "./readiumEngine.css";
import { getEpubSession } from "@/lib/bridge";
import type { ReadingProgressRecord } from "@/types/domain";
import {
  EPUB_PROGRESS_SCHEMA_VERSION,
  convertFoliateRow,
  type ProgressSource,
  type SerializedLocator,
} from "./progressMigration";

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

/** Payload of the engine's position-changed event, narrowed to what we persist. */
export interface EpubRelocateDetail {
  /**
   * Canonical locator of the reading position: the serialized Readium
   * locator JSON. E2E reads the pinned attribute this feeds instead of
   * inferring position from page-level state.
   */
  locator: string;
  /** In-section progression (0..1) as the engine reports it. */
  fraction: number;
  /** Spine position; `section.current + 1 of total`. */
  section: EpubSectionProgress;
  /** Overall progression (0..1) through the book, when the engine has one. */
  totalProgression: number;
  /** Nearest TOC entry at or before the position, when one exists. */
  tocItem: { label: string; href: string } | null;
}

/** Payload of the engine's frame-loaded event (a section document mounted). */
export interface EpubLoadDetail {
  /** Spine index of the loaded section. */
  index: number;
  /** The mounted section document (sandboxed same-origin iframe document). */
  doc: Document;
}

/** Surrounding text around one search match. */
export interface EpubSearchExcerpt {
  pre: string;
  match: string;
  post: string;
}

/** One content match: the locator to jump to plus its excerpt. */
export interface EpubSearchMatch {
  locator: string;
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

/**
 * Inline-size cap for the reading surface in scrolled flow (PERF-12,
 * docs/performance.md). The paginated spread is capped by the engine's own
 * grid, but its scrolled flow stretches the section frame across the full
 * host width; `EpubReader` caps its own container at this width in scrolled
 * flow only, and the shell around the cap is bridged to the engine's theme
 * background.
 */
export const EPUB_SCROLLED_SURFACE_MAX_PX = 960;

export const EPUB_MIME_TYPE = "application/epub+zip";

/** Background color the engine paints for a theme. */
export type EpubThemeName = "light" | "paper" | "dark";

export function epubThemeBackground(theme: EpubThemeName): string {
  return THEME_COLORS[theme].background;
}

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

const XHTML_TYPE = "application/xhtml+xml";
const HTML_TYPE = "text/html";
/** Upper bound on in-book search matches (same contract as the PDF reader). */
const SEARCH_MAX_MATCHES = 500;

/**
 * Bound on one `navigator.load()` attempt. The toolkit's frame-comms
 * handshake drops acks under load occasionally, which would otherwise wedge
 * the reader on a blank surface forever (see navigatorLoad).
 */
const EPUB_LOAD_TIMEOUT_MS = 8_000;

function asString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
}

/**
 * Typed wrapper around one `EpubNavigator` instance, created per open book
 * by `EpubReader`. Owns the publication, the listeners, the search walk,
 * and the highlight decorations; the unsubscribers returned by `on*`
 * helpers detach listeners.
 */
export class ReadiumEpubHandle {
  private readonly bookId: number;
  private readonly publication: Publication;
  private readonly fetcher: HttpFetcher;
  private readonly positions: Locator[];
  private readonly mediaTypes: Map<string, string>;
  private navigator: EpubNavigator | null = null;
  private readonly host: HTMLDivElement;
  private readonly container: HTMLDivElement;
  private relocateHandlers = new Set<(detail: EpubRelocateDetail) => void>();
  private loadHandlers = new Set<(detail: EpubLoadDetail) => void>();
  private externalLinkHandlers = new Set<(href: string) => void>();
  private selectionHandlers = new Set<(selection: { text: string }) => void>();

  private currentLocator: Locator | null = null;
  private toc: EpubTocItem[] = [];
  private tocLabels: { label: string; href: string }[] = [];

  private searchGeneration = 0;
  private readonly highlights = new Map<string, string>();
  /**
   * Navigation serialization: user navigation (jumps, page turns) must run
   * strictly after the restored-locator load has settled. The frame pool
   * dedupes in-flight updates per href, not globally — a navigation issued
   * while the initial frame update is still loading can be re-ordered
   * behind it (the stale restore re-applies over the user's jump).
   */
  private initChain: Promise<void> = Promise.resolve();
  private pendingSelection: {
    wire: BasicTextSelection;
    doc: Document | null;
    range: Range | null;
    text: string;
  } | null = null;

  private constructor(bookId: number, manifestJson: unknown, positionsJson: unknown) {
    this.bookId = bookId;
    const sessionBaseUrl = `tuxbooks://book/${bookId}/`;

    const manifest = Manifest.deserialize(manifestJson);
    if (!manifest) throw new Error("EPUB session manifest is not a valid webpub manifest");
    manifest.setSelfLink(`${sessionBaseUrl}manifest.json`);

    const fetcher = new HttpFetcher(undefined, sessionBaseUrl);
    this.fetcher = fetcher;
    this.publication = new Publication({ manifest, fetcher });

    this.mediaTypes = new Map<string, string>();
    for (const item of this.publication.readingOrder.items) {
      this.mediaTypes.set(item.href, item.type ?? XHTML_TYPE);
    }

    this.positions = buildPositions(this.publication, positionsJson);

    // The host element React mounts; the navigator renders inside a plain
    // child div (its own sizing chain, like the foliate `<foliate-view>`).
    // The container is the containing block for the navigator's absolutely
    // positioned section iframes (readiumEngine.css sizes them to fill it).
    this.host = document.createElement("div");
    this.host.setAttribute("data-epub-host", "");
    this.host.style.width = "100%";
    this.host.style.height = "100%";
    this.container = document.createElement("div");
    this.container.style.position = "relative";
    this.container.style.width = "100%";
    this.container.style.height = "100%";
    this.host.appendChild(this.container);

    this.toc = mapToc(this.publication.toc?.items ?? []);
    this.collectTocLabels(this.toc);
  }

  /** Fetches the session and prepares the publication. Not yet rendering. */
  static async open(bookId: number): Promise<ReadiumEpubHandle> {
    const session = await getEpubSession(bookId);
    return new ReadiumEpubHandle(bookId, session.manifest, session.positions);
  }

  /** The element React mounts; the navigator lives inside it. */
  get hostElement(): HTMLDivElement {
    return this.host;
  }

  /** TOC tree of the opened book (available as soon as `open` resolves). */
  getToc(): EpubTocItem[] {
    return this.toc;
  }

  /** Spine href of the section at `index` (`chapterHref` for persistence). */
  getSectionHref(index: number): string | null {
    return this.publication.readingOrder.items[index]?.href ?? null;
  }

  /** Spine index of a locator href, or null when the href is not in the spine. */
  private sectionIndexOf(href: string): number | null {
    const path = href.split("#")[0];
    const index = this.publication.readingOrder.items.findIndex((item) => item.href === path);
    return index === -1 ? null : index;
  }

  /**
   * Parse + mount the navigator, restoring to the saved position first so
   * the reader never flashes the start of the book. Must run after the host
   * is mounted; the first `positionChanged` follows `load()`.
   */
  async init(saved: ReadingProgressRecord | null): Promise<void> {
    const initialLocator = await this.resolveInitialLocator(saved);
    // Serialize behind any navigation that slipped in before the load (the
    // shell only navigates after ready, but a hot Home/progress-bar press
    // can race the restore — see the initChain note above).
    this.initChain = this.navigatorLoad(initialLocator);
    await this.initChain;
  }

  private async navigatorLoad(initialLocator: Locator | undefined): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const navigator = new EpubNavigator(
        this.container,
        this.publication,
        {
          positionChanged: (locator) => this.handlePositionChanged(locator),
          frameLoaded: (wnd) => this.handleFrameLoaded(wnd),
          handleLocator: (locator) => this.handleLocator(locator),
          textSelected: (selection) => this.handleTextSelected(selection),
          timelineItemChanged: () => {},
          zoom: () => {},
          miscPointer: () => {},
          scroll: () => {},
          customEvent: () => {},
          contentProtection: () => {},
          contextMenu: () => {},
          peripheral: () => {},
          tap: () => false,
          click: () => false,
        },
        this.positions,
        initialLocator,
        { preferences: {}, defaults: {} },
      );
      this.navigator = navigator;
      // The toolkit's frame-comms handshake can drop an ack under load,
      // leaving load() unsettled forever (the reader wedges on a blank
      // surface). Bound each attempt; a fresh navigator re-runs the whole
      // handshake. Two attempts: a transient race recovers, a systematic
      // failure surfaces as the reader's error state.
      const outcome = await Promise.race([
        navigator.load().then(
          () => "ok" as const,
          () => "error" as const,
        ),
        new Promise<"timeout">((resolve) =>
          window.setTimeout(() => resolve("timeout"), EPUB_LOAD_TIMEOUT_MS),
        ),
      ]);
      if (outcome === "ok") return;
      console.warn(`epub engine load ${outcome}; retrying`, attempt);
      this.container.replaceChildren();
      await Promise.race([
        navigator.destroy().catch(() => {}),
        new Promise<void>((resolve) => window.setTimeout(resolve, 1_000)),
      ]);
    }
    throw new Error("the EPUB engine did not finish loading");
  }

  /**
   * Resolve the saved row into an initial locator, walking the documented
   * fallback hierarchy. Idempotent: a row already carrying a Readium
   * locator (`engine === "readium"`) deserializes directly; foliate-era
   * rows convert through the migration adapter.
   */
  private async resolveInitialLocator(
    saved: ReadingProgressRecord | null,
  ): Promise<Locator | undefined> {
    if (!saved) return undefined;

    if (saved.engine === "readium" && saved.locator) {
      return this.toLocator(saved.locator);
    }

    if (saved.progressPercent !== null && !saved.cfi && !saved.chapterHref && !saved.locator) {
      // Percentage-only row: nearest position at or before the fraction.
      return this.locatorForTotalProgression(clamp01(saved.progressPercent / 100));
    }

    const target = await convertFoliateRow(saved, this.progressSource());
    if (target === null) return undefined;
    if (target.tier === "book-percentage") {
      return this.locatorForTotalProgression(target.totalProgression);
    }
    return this.toLocator(target.locator);
  }

  /** What the open publication offers the migration adapter. */
  private progressSource(): ProgressSource {
    const spineHrefs = this.publication.readingOrder.items.map((item) => item.href);
    return {
      spineHrefs,
      readChapter: async (spineIndex) => {
        const link = this.publication.readingOrder.items[spineIndex];
        if (!link) return null;
        return this.readDocument(link);
      },
    };
  }

  private async readDocument(link: Link): Promise<Document | null> {
    try {
      const text = await this.publication.get(link).readAsString();
      if (!text) return null;
      const doc = new DOMParser().parseFromString(text, XHTML_TYPE);
      return doc.querySelector("parsererror") === null
        ? doc
        : new DOMParser().parseFromString(text, HTML_TYPE);
    } catch {
      return null;
    }
  }

  /**
   * Parse locator JSON (app grammar: serialized Readium locator, optionally
   * without a media type) into a real `Locator`, injecting the spine item's
   * media type so `Locator.deserialize` accepts it. Legacy foliate CFIs
   * (stored annotations) convert through the migration adapter on the fly.
   */
  async toLocator(target: string): Promise<Locator | undefined> {
    const trimmed = target.trim();
    if (trimmed.length === 0) return undefined;

    if (trimmed.startsWith("epubcfi(")) {
      const converted = await convertFoliateRow(
        { cfi: trimmed, chapterHref: null, progressPercent: null },
        this.progressSource(),
      );
      if (converted === null || converted.tier === "book-percentage") return undefined;
      return this.toLocator(converted.locator);
    }

    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return undefined;
    }
    return this.locatorFromJson(json);
  }

  /** Inject the media type and parse one locator JSON record. */
  private locatorFromJson(json: unknown): Locator | undefined {
    if (json === null || typeof json !== "object") return undefined;
    const record = json as { href?: unknown; type?: unknown };
    if (typeof record.href !== "string") return undefined;
    const href = record.href.split("#")[0] ?? "";
    const type =
      typeof record.type === "string" && record.type.length > 0
        ? record.type
        : (this.mediaTypes.get(href) ?? XHTML_TYPE);
    const locator = Locator.deserialize({ ...(json as object), type }) ?? undefined;
    return locator === undefined ? undefined : this.snapToPosition(locator);
  }

  /**
   * Snap a locator onto the engine's position list. The navigator's
   * timeline resolves locators through their `position` entry — a bare
   * converted locator (quote/fragment only) is rejected with "Locator not
   * found in position list". Merging the nearest position's context
   * (position / totalProgression / progression) with the locator's precise
   * target (fragment, CSS selector, text quote) satisfies both.
   */
  private snapToPosition(locator: Locator): Locator {
    const href = locator.href.split("#")[0] ?? "";
    const candidates = this.positions.filter(
      (position) => (position.href.split("#")[0] ?? "") === href,
    );
    if (candidates.length === 0) return locator;
    const progression = locator.locations.progression ?? 0;
    let best = candidates[0] ?? locator;
    for (const candidate of candidates) {
      if ((candidate.locations.progression ?? 0) <= progression) best = candidate;
    }
    if (best === locator) return locator;

    const mergedLocations: Record<string, unknown> = {
      ...(best.locations.serialize() as Record<string, unknown>),
    };
    const own = locator.locations.serialize() as Record<string, unknown>;
    const ownFragments = own.fragments;
    if (Array.isArray(ownFragments) && ownFragments.length > 0) {
      mergedLocations.fragments = ownFragments;
    }
    if (typeof own.cssSelector === "string" && own.cssSelector.length > 0) {
      mergedLocations.cssSelector = own.cssSelector;
    }
    const text = locator.text?.serialize();
    const snapped =
      Locator.deserialize({
        href: locator.href,
        type: locator.type ?? this.mediaTypes.get(href) ?? XHTML_TYPE,
        locations: mergedLocations,
        ...(text !== undefined ? { text } : {}),
      }) ?? locator;
    return snapped;
  }

  /** Real `Locator` from a built app-level locator object. */
  private locatorFromBuilt(built: SerializedLocator): Locator | undefined {
    return this.locatorFromJson(serializeBuiltLocator(built));
  }

  /** Nearest position at or before `totalProgression` (0..1). */
  private locatorForTotalProgression(totalProgression: number): Locator | undefined {
    let best: Locator | undefined;
    let bestValue = -1;
    for (const position of this.positions) {
      const value = position.locations.totalProgression ?? 0;
      if (value <= totalProgression && value >= bestValue) {
        best = position;
        bestValue = value;
      }
    }
    return best ?? this.positions[0] ?? undefined;
  }

  // Engine events ----------------------------------------------------------------

  private handlePositionChanged(locator: Locator): void {
    this.currentLocator = locator;
    this.relocateCount += 1;
    const sectionIndex = this.sectionIndexOf(locator.href);
    const section = {
      current: sectionIndex === null ? 0 : sectionIndex,
      total: this.sectionTotal(),
    };
    const detail: EpubRelocateDetail = {
      locator: serializeLocator(locator),
      fraction: clamp01(locator.locations.progression ?? 0),
      section,
      totalProgression: this.totalProgressionOf(locator),
      tocItem: this.nearestTocLabel(locator.href),
    };
    for (const handler of this.relocateHandlers) handler(detail);
  }

  /**
   * Overall progression (0..1) of a relocate locator. The engine's own
   * totalProgression steps in position-list granularity — within a chapter,
   * page turns update the in-section fraction while the position entry (and
   * with it the coarse totalProgression) stays put, freezing the shell's
   * percent mid-chapter. Interpolating between the chapter's first and last
   * position restores the smooth per-turn movement the shell footer needs.
   */
  private totalProgressionOf(locator: Locator): number {
    const href = locator.href.split("#")[0] ?? "";
    const progression = locator.locations.progression;
    if (Number.isFinite(progression)) {
      let first: number | undefined;
      let last: number | undefined;
      for (const position of this.positions) {
        if ((position.href.split("#")[0] ?? "") !== href) continue;
        first ??= position.locations.totalProgression;
        last = position.locations.totalProgression;
      }
      if (typeof first === "number" && typeof last === "number") {
        return clamp01(first + (last - first) * clamp01(progression ?? 0));
      }
    }
    return clamp01(locator.locations.totalProgression ?? 0);
  }

  private handleFrameLoaded(wnd: Window): void {
    const doc = wnd.document;
    const href = this.currentLocator?.href ?? "";
    const index = this.sectionIndexOf(href);
    for (const handler of this.loadHandlers) {
      handler({ index: index === null ? 0 : index, doc });
    }
  }

  /**
   * The engine routes unhandled hrefs here: absolute web targets
   * (http/mailto/tel) are external links — reported, never navigated —
   * and in-book anchors are handed back to the engine (return false).
   */
  private handleLocator(locator: Locator): boolean {
    const href = locator.href ?? "";
    if (/^(https?:|mailto:|tel:)/i.test(href)) {
      for (const handler of this.externalLinkHandlers) handler(href);
      return true;
    }
    return false;
  }

  private handleTextSelected(selection: BasicTextSelection): void {
    const text = asString(selection.text).replace(/\s+/g, " ").trim();
    if (text === "") {
      this.pendingSelection = null;
      for (const handler of this.selectionHandlers) handler({ text: "" });
      return;
    }
    // Enrich the wire selection with the live DOM range from the frame
    // (same-origin sandboxed iframe), so highlight creation is anchored
    // exactly — the quote locator needs the surrounding text.
    let doc: Document | null = null;
    let range: Range | null = null;
    try {
      const frame = this.frameWindowFor(selection.targetFrameSrc);
      const live = frame?.getSelection();
      if (live && live.rangeCount > 0 && !live.isCollapsed) {
        range = live.getRangeAt(0).cloneRange();
        doc = frame?.document ?? null;
      }
    } catch {
      // A closed frame or cross-realm hiccup degrades to quote-only.
    }
    this.pendingSelection = { wire: selection, doc, range, text };
    for (const handler of this.selectionHandlers) handler({ text });
  }

  private frameWindowFor(targetFrameSrc: string): Window | null {
    for (const frame of this.container.querySelectorAll("iframe")) {
      const win = frame.contentWindow;
      if (!win) continue;
      try {
        if (win.location.href === targetFrameSrc) return win;
      } catch {
        continue;
      }
    }
    return null;
  }

  onRelocate(handler: (detail: EpubRelocateDetail) => void): () => void {
    this.relocateHandlers.add(handler);
    return () => this.relocateHandlers.delete(handler);
  }

  onLoad(handler: (detail: EpubLoadDetail) => void): () => void {
    this.loadHandlers.add(handler);
    return () => this.loadHandlers.delete(handler);
  }

  /** External links must not navigate the reading surface; handlers observe them. */
  onExternalLink(handler: (href: string) => void): () => void {
    this.externalLinkHandlers.add(handler);
    return () => this.externalLinkHandlers.delete(handler);
  }

  /** Reports the current selection's text ("" when nothing is selected). */
  onSelection(handler: (selection: { text: string }) => void): () => void {
    this.selectionHandlers.add(handler);
    return () => this.selectionHandlers.delete(handler);
  }

  // Navigation -------------------------------------------------------------------

  /**
   * Run a navigation once the restore's frame update has settled (see the
   * initChain note): strictly after the initial load, never interleaved
   * with it.
   */
  private async settled<T>(navigation: () => T | Promise<T>): Promise<void> {
    await this.initChain;
    await navigation();
  }

  /**
   * Navigate to an app-level locator: a spine index (number), a serialized
   * locator JSON, or a legacy foliate CFI (annotations migrate on the fly).
   */
  async goTo(target: string | number): Promise<void> {
    await this.settled(async () => {
      const navigator = this.navigator;
      if (!navigator) return;
      if (typeof target === "number") {
        const link = this.publication.readingOrder.items[target];
        if (link) navigator.goLink(link, false, () => {});
        return;
      }
      const locator = await this.toLocator(target);
      if (locator) navigator.go(locator, false, () => {});
    });
  }

  /** Serialized locator of the current position (what a bookmark persists). */
  getCurrentLocator(): string | null {
    return this.currentLocator === null ? null : serializeLocator(this.currentLocator);
  }

  /** Current overall progression (0..1), for bootstrapping shell state. */
  getFraction(): number {
    return clamp01(this.currentLocator?.locations.totalProgression ?? 0);
  }

  next(): Promise<void> {
    return this.move("forward");
  }

  prev(): Promise<void> {
    return this.move("backward");
  }

  /** Monotonic count of relocate events (move-settled detection). */
  private relocateCount = 0;

  /**
   * One engine page turn, bounded. The engine's cb fires on settled moves;
   * a delayed resolve keeps a boundary move that never settles from
   * wedging navigation.
   */
  private attemptMove(direction: "forward" | "backward"): Promise<void> {
    return new Promise<void>((resolve) => {
      const navigator = this.navigator;
      if (!navigator) {
        resolve();
        return;
      }
      const done = () => resolve();
      if (direction === "forward") navigator.goForward(false, done);
      else navigator.goBackward(false, done);
      window.setTimeout(resolve, 1_000);
    });
  }

  /**
   * Engine page turn with swallow-recovery. Keys pressed while the engine
   * is still settling its initial layout can be dropped by the toolkit's
   * frame comms: a dropped ack leaves the navigator's busy flag stuck and
   * every later turn early-returns. A move that produces no relocate is
   * retried, and if the retry also produces nothing the navigator is
   * rebuilt at the current position and the turn re-issued — a reader
   * pressing an arrow must never lose page turns for the session. A
   * legitimate boundary (start/end of book) also produces no relocate; the
   * recovery costs a bounded delay only there.
   */
  private move(direction: "forward" | "backward"): Promise<void> {
    return this.settled(async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = this.relocateCount;
        await this.attemptMove(direction);
        const deadline = Date.now() + 500;
        while (this.relocateCount === before && Date.now() < deadline) {
          await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
        }
        if (this.relocateCount !== before) return;
      }
      // Wedged: rebuild at the current position and re-issue the turn once.
      console.warn("epub engine navigation wedged; rebuilding the navigator");
      await this.rebuildNavigator();
      const before = this.relocateCount;
      await this.attemptMove(direction);
      const deadline = Date.now() + 500;
      while (this.relocateCount === before && Date.now() < deadline) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      }
    });
  }

  /**
   * Tear down and re-mount the navigator at `locator`. Recovery path for a
   * wedged toolkit session (see {@link move}): the old instance is destroyed
   * with a bounded wait (its comms may be the wedged part), the container is
   * cleared, and a fresh navigator takes over. Highlights re-apply; an
   * in-flight search's decorations do not survive and are cleared.
   */
  private async rebuildNavigator(): Promise<void> {
    const locator = this.currentLocator ?? this.positions[0];
    if (locator === undefined) return;
    const stale = this.navigator;
    this.navigator = null;
    this.container.replaceChildren();
    this.clearSearch();
    if (stale !== null) {
      await Promise.race([
        stale.destroy().catch(() => {}),
        new Promise<void>((resolve) => window.setTimeout(resolve, 1_000)),
      ]);
    }
    await this.navigatorLoad(locator);
    await this.applyHighlights();
  }

  /** Applies the reflow layout; no-op before `load()`. */
  async setFlow(flow: EpubFlow): Promise<void> {
    if (!this.navigator) return;
    await this.navigator.submitPreferences(new EpubPreferences({ scroll: flow === "scrolled" }));
  }

  /**
   * User appearance over publisher styles, through the engine's Preferences
   * API (ReadiumCSS injects the user properties into every section frame).
   */
  async setAppearance(appearance: EpubAppearance): Promise<void> {
    if (!this.navigator) return;
    const colors = THEME_COLORS[appearance.theme];
    await this.navigator.submitPreferences(
      new EpubPreferences({
        backgroundColor: colors.background,
        textColor: colors.text,
        linkColor: colors.link,
        fontSize: appearance.fontSize,
        lineHeight: appearance.lineHeight,
        fontFamily:
          appearance.fontFamily === null ? null : EPUB_FONT_FAMILIES[appearance.fontFamily],
      }),
    );
  }

  // Search -----------------------------------------------------------------------

  /**
   * Whole-book search over actual EPUB content: walks the spine, matches
   * inside each section document, and streams results per section through
   * `callbacks`. Matches draw into the rendered pages as highlight
   * decorations until the next search or `clearSearch`. Starting a new
   * search supersedes a running one; returns a cancel function.
   */
  search(query: string, callbacks: EpubSearchCallbacks): () => void {
    const generation = ++this.searchGeneration;
    const items = this.publication.readingOrder.items.filter(
      (item) => item.type === XHTML_TYPE || item.type === HTML_TYPE,
    );
    void this.consumeSearch(query.trim(), items, generation, callbacks).finally(() => {
      // A superseded walk never fires its predecessor's callbacks.
      if (generation === this.searchGeneration) callbacks.onDone();
    });
    return () => {
      if (generation === this.searchGeneration) this.clearSearch();
    };
  }

  private async consumeSearch(
    query: string,
    items: Link[],
    generation: number,
    callbacks: EpubSearchCallbacks,
  ): Promise<void> {
    if (query.length === 0) return;
    const decorations: Decoration[] = [];
    let matchCount = 0;
    let unlabeledOrdinal = 0;
    for (let index = 0; index < items.length; index += 1) {
      if (generation !== this.searchGeneration) return;
      if (matchCount >= SEARCH_MAX_MATCHES) break;
      callbacks.onProgress?.(index / Math.max(items.length, 1));
      const item = items[index];
      if (item === undefined) continue;
      const doc = await this.readDocument(item);
      if (generation !== this.searchGeneration) return;
      if (!doc) continue;
      const subitems: EpubSearchMatch[] = [];
      const href = item.href;
      for (const [built, excerpt] of matchInDocument(doc, query)) {
        if (matchCount >= SEARCH_MAX_MATCHES) break;
        const locator = { ...built, href };
        const full = this.locatorFromBuilt(locator);
        if (!full) continue;
        subitems.push({ locator: JSON.stringify(locator), excerpt });
        decorations.push({
          id: `search-${generation}-${decorations.length}`,
          locator: full,
          style: { type: "highlight", tint: "#ffd54f", expand: 2 },
        });
        matchCount += 1;
      }
      if (subitems.length > 0) {
        const label = this.tocLabels.find((entry) => this.sectionIndexOf(entry.href) === index);
        callbacks.onSection({
          label:
            label?.label !== undefined && label.label !== ""
              ? label.label
              : `Chapter ${++unlabeledOrdinal}`,
          subitems,
        });
        this.navigator?.applyDecorations(decorations, "search");
      }
      // Yield between sections so a superseded search cancels promptly.
      await Promise.resolve();
    }
  }

  /** Removes all match highlights from the rendered pages. */
  clearSearch(): void {
    this.searchGeneration += 1;
    this.navigator?.applyDecorations([], "search");
  }

  // Highlights -------------------------------------------------------------------

  /**
   * Draws a highlight at the locator and keeps it for section remounts
   * (the navigator re-applies group decorations to mounted frames).
   */
  addHighlight(locator: string, color: string): void {
    this.highlights.set(locator, color);
    void this.applyHighlights();
  }

  /** Removes a highlight from the overlays and the remount bookkeeping. */
  removeHighlight(locator: string): void {
    this.highlights.delete(locator);
    void this.applyHighlights();
  }

  private async applyHighlights(): Promise<void> {
    const navigator = this.navigator;
    if (!navigator) return;
    const keys = Array.from(this.highlights.keys());
    const locators = await Promise.all(keys.map((locator) => this.toLocator(locator)));
    const active = this.navigator;
    if (!active) return;
    const decorations: Decoration[] = [];
    locators.forEach((full, index) => {
      if (!full) return;
      const key = keys[index];
      decorations.push({
        id: `highlight-${index}`,
        locator: full,
        style: {
          type: "highlight",
          tint: highlightTint(key === undefined ? "" : (this.highlights.get(key) ?? "")),
        },
      });
    });
    active.applyDecorations(decorations, "highlights");
  }

  /**
   * Canonical locator for a text selection, plus that section's spine href
   * and the selection text. Null when nothing is selected or the section
   * cannot be determined.
   */
  getLocatorFromSelection(): {
    locator: string;
    href: string | null;
    text: string;
  } | null {
    const pending = this.pendingSelection;
    if (!pending || pending.text === "") return null;

    const href = pending.wire.locator?.href ?? this.currentLocator?.href ?? "";
    const spineIndex = this.sectionIndexOf(href);
    const spineHref = spineIndex === null ? null : this.getSectionHref(spineIndex);

    let before: string | undefined;
    let after: string | undefined;
    if (pending.doc && pending.range) {
      const rawBefore = textBeforeRange(pending.doc, pending.range);
      const rawAfter = textAfterRange(pending.doc, pending.range);
      before = rawBefore.length > 0 ? rawBefore : undefined;
      after = rawAfter.length > 0 ? rawAfter : undefined;
    }
    const sectionHref = href !== "" ? href : (spineHref ?? "");
    if (sectionHref === "") return null;
    const built: SerializedLocator = {
      href: sectionHref,
      locations: {},
      text: {
        highlight: pending.text,
        before,
        after,
      },
    };
    return {
      locator: JSON.stringify(serializeBuiltLocator(built)),
      href: spineHref,
      text: pending.text,
    };
  }

  /** Drops the pending selection and clears the live frame selection. */
  clearSelection(): void {
    this.pendingSelection = null;
    for (const frame of this.container.querySelectorAll("iframe")) {
      try {
        frame.contentWindow?.getSelection()?.removeAllRanges();
      } catch {
        continue;
      }
    }
  }

  /** Navigate to the nearest position at or before a book fraction (0..1). */
  async goToTotalProgression(totalProgression: number): Promise<void> {
    await this.settled(() => {
      const navigator = this.navigator;
      const locator = this.locatorForTotalProgression(clamp01(totalProgression));
      if (navigator && locator) navigator.go(locator, false, () => {});
    });
  }

  /** Destroys the navigator and frees the publication. */
  async close(): Promise<void> {
    this.searchGeneration += 1;
    this.relocateHandlers.clear();
    this.loadHandlers.clear();
    this.externalLinkHandlers.clear();
    this.selectionHandlers.clear();
    const navigator = this.navigator;
    this.navigator = null;
    if (navigator) await navigator.destroy();
    this.fetcher.close();
    this.host.remove();
  }

  // TOC --------------------------------------------------------------------------

  private collectTocLabels(items: EpubTocItem[]): void {
    for (const item of items) {
      if (item.label !== "") this.tocLabels.push({ label: item.label, href: item.href });
      this.collectTocLabels(item.subitems);
    }
  }

  /** Nearest TOC label at or before `href` (spine order), when one exists. */
  private nearestTocLabel(href: string): { label: string; href: string } | null {
    const index = this.sectionIndexOf(href);
    if (index === null) return null;
    let best: { label: string; href: string } | null = null;
    let bestIndex = -1;
    for (const entry of this.tocLabels) {
      const entryIndex = this.sectionIndexOf(entry.href);
      if (entryIndex === null || entryIndex > index) continue;
      if (entryIndex >= bestIndex) {
        best = entry;
        bestIndex = entryIndex;
      }
    }
    return best;
  }

  /** The session's schema version marker (what conversion saves write). */
  get schemaVersion(): number {
    return EPUB_PROGRESS_SCHEMA_VERSION;
  }

  /** True when this handle serves `bookId` (book-switch staleness check). */
  serves(bookId: number): boolean {
    return this.bookId === bookId;
  }

  private sectionTotal(): number {
    return this.publication.readingOrder.items.length;
  }
}

// Locator helpers ----------------------------------------------------------------

/** Serialize a real `Locator` to the app's canonical locator JSON. */
export function serializeLocator(locator: Locator): string {
  return JSON.stringify(locator.serialize());
}

function serializeBuiltLocator(built: SerializedLocator): SerializedLocator {
  return {
    href: built.href,
    locations: built.locations,
    ...(built.text ? { text: built.text } : {}),
  };
}

function highlightTint(color: string): string {
  return color.startsWith("#") || color.startsWith("rgb") ? color : "#ffe082";
}

/** Parse + build the engine's positions list from the session JSON. */
function buildPositions(publication: Publication, positionsJson: unknown): Locator[] {
  if (positionsJson === null || typeof positionsJson !== "object") return [];
  const list = positionsJson as { positions?: unknown[] };
  if (!Array.isArray(list.positions) || list.positions.length === 0) return [];
  const mediaTypes = new Map<string, string>();
  for (const item of publication.readingOrder.items) {
    mediaTypes.set(item.href, item.type ?? XHTML_TYPE);
  }
  const locators: Locator[] = [];
  for (const entry of list.positions) {
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as { href?: unknown };
    if (typeof record.href !== "string") continue;
    const href = record.href.split("#")[0] ?? "";
    locators.push(
      Locator.deserialize({
        ...(entry as object),
        type: mediaTypes.get(href) ?? XHTML_TYPE,
      }) ?? new Locator({ href, type: XHTML_TYPE }),
    );
  }
  return locators;
}

/** Map the manifest's toc tree to the app's TOC node shape. */
function mapToc(items: Link[]): EpubTocItem[] {
  return items.map((item) => ({
    label: item.title ?? "",
    href: item.href,
    subitems: mapToc(item.children?.items ?? []),
  }));
}

// Search text matching -----------------------------------------------------------

/**
 * Case-insensitive whole-document text matching with excerpts. The built
 * locator carries an empty href; the search caller fills the section href.
 */
function* matchInDocument(
  doc: Document,
  query: string,
): Generator<[SerializedLocator, EpubSearchExcerpt]> {
  const body = doc.body ?? doc.documentElement;
  if (!body) return;
  const walker = doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
  const needle = query.toLowerCase();
  if (needle.length === 0) return;
  let node = walker.nextNode();
  while (node !== null) {
    const text = node.textContent ?? "";
    const lowered = text.toLowerCase();
    let cursor = 0;
    for (;;) {
      const at = lowered.indexOf(needle, cursor);
      if (at === -1) break;
      const excerpt = excerptAround(text, at, needle.length);
      yield [
        {
          href: "",
          locations: {},
          text: {
            highlight: excerpt.match,
            before: excerpt.pre,
            after: excerpt.post,
          },
        },
        excerpt,
      ];
      cursor = at + needle.length;
    }
    node = walker.nextNode();
  }
}

/** Excerpt around a match inside one text node. */
function excerptAround(text: string, at: number, length: number): EpubSearchExcerpt {
  const context = 48;
  return {
    pre: text.slice(Math.max(0, at - context), at).trim(),
    match: text.slice(at, at + length),
    post: text.slice(at + length, at + length + context).trim(),
  };
}

/** Short text immediately before/after a live DOM range, for quote context. */
function textBeforeRange(doc: Document, range: Range): string {
  const probe = doc.createRange();
  probe.setStart(doc, 0);
  probe.setEnd(range.startContainer, range.startOffset);
  const text = probe.toString();
  probe.detach();
  return text.slice(Math.max(0, text.length - 40)).trim();
}

function textAfterRange(doc: Document, range: Range): string {
  const probe = doc.createRange();
  probe.setStart(range.endContainer, range.endOffset);
  probe.setEnd(doc, doc.childNodes.length);
  const text = probe.toString();
  probe.detach();
  return text.slice(0, 40).trim();
}

export type { Decoration };
