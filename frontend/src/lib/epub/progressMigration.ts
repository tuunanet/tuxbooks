/**
 * Foliate → Readium reading-progress migration (docs/epub.md). Stored
 * progress is user data: rows written
 * by the foliate engine (`cfi` + `chapterHref` + coarse `progressPercent`,
 * migration 0004) are converted into Readium locators, validated against
 * the actual EPUB, without ever resetting or destructively rewriting the
 * row — the legacy columns stay as provenance and the conversion is
 * versioned + idempotent (a row with `engine` set is never re-converted).
 *
 * The Readium navigator resolves locators through text quotes, CSS
 * selectors, or fragment ids — never EPUB CFI — so the foliate CFI is
 * parsed here and rebuilt into the locator grammar the engine understands.
 *
 * Fallback hierarchy (docs/epub.md):
 *   exact location → CFI structure → spine+element/offset →
 *   spine+progression → book percentage → beginning.
 * A locator-bearing row that fails every locator tier degrades to the
 * beginning rather than trusting a stale percentage against a different
 * file; the book-percentage tier is reserved for rows that never had a
 * locator. This module is pure: the chapter documents come from an injected
 * `ProgressSource`, so unit tests run without the engine or the protocol.
 */

/** Schema version of the Readium locator columns this module writes. */
export const EPUB_PROGRESS_SCHEMA_VERSION = 2;

/** One EPUB CFI step: `/N`, text when odd, with an optional `:offset`. */
export interface CfiStep {
  value: number;
  isText: boolean;
  charOffset?: number;
}

/** The foliate CFI subset this migration understands. */
export interface FoliateCfi {
  /** 0-based spine index (from the itemref step before `!`). */
  spineIndex: number;
  /** Content-document path steps after `!` (start boundary for ranges). */
  docSteps: CfiStep[];
}

/**
 * Parse a foliate-style canonical CFI: `epubcfi(/6/2!/4,/2,/6/1:89)` (range)
 * or `epubcfi(/6/4!/4/2/1:62)` (point). Tolerant of the bracket assertions
 * foliate emits (`/4[chapter2]`) and of the range's start/end split — the
 * start path is what a restore needs. Returns null for anything malformed
 * rather than throwing; never trusts garbage into a spine index.
 */
export function parseFoliateCfi(cfi: string): FoliateCfi | null {
  const match = /^epubcfi\((.*)\)$/.exec(cfi.trim());
  if (!match || match[1] === undefined) return null;
  const body = match[1];
  const bang = body.indexOf("!");
  if (bang === -1) return null;

  const spineSteps = parseSteps(body.slice(0, bang));
  if (!spineSteps || spineSteps.length === 0) return null;
  // The last spine step is the itemref: /2k for the k-th item (1-based).
  const itemStep = spineSteps[spineSteps.length - 1];
  if (itemStep === undefined) return null;
  if (itemStep.isText || itemStep.charOffset !== undefined) return null;
  if (itemStep.value < 2 || itemStep.value % 2 !== 0) return null;
  const spineIndex = itemStep.value / 2 - 1;
  if (spineIndex < 0 || !Number.isSafeInteger(spineIndex)) return null;

  const afterBang = body.slice(bang + 1);
  const startPath = afterBang.split(",")[0] ?? "";
  const docSteps = parseSteps(startPath);
  if (!docSteps) return null;
  return { spineIndex, docSteps };
}

/** Parse a run of `/N[:M]` steps, skipping `[...]` id assertions. */
function parseSteps(input: string): CfiStep[] | null {
  const steps: CfiStep[] = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === "[") {
      const close = input.indexOf("]", i);
      if (close === -1) return null;
      i = close + 1;
      continue;
    }
    if (input[i] !== "/") break;
    i += 1;
    const start = i;
    while (i < input.length && input.charAt(i) >= "0" && input.charAt(i) <= "9") i += 1;
    if (i === start) return null;
    const value = Number(input.slice(start, i));
    if (!Number.isSafeInteger(value) || value < 1) return null;
    const isText = value % 2 === 1;
    let charOffset: number | undefined;
    if (i < input.length && input.charAt(i) === ":") {
      i += 1;
      const offsetStart = i;
      while (i < input.length && input.charAt(i) >= "0" && input.charAt(i) <= "9") i += 1;
      if (i === offsetStart) return null;
      charOffset = Number(input.slice(offsetStart, i));
      if (!Number.isSafeInteger(charOffset) || charOffset < 0) return null;
    }
    steps.push({ value, isText, charOffset });
  }
  return steps;
}

/**
 * The stored row's locator-bearing fields, narrowed to what the conversion
 * reads (the record's other columns are irrelevant here).
 */
export interface FoliateProgressRow {
  cfi: string | null;
  chapterHref: string | null;
  /** Coarse shell position 0..=100. */
  progressPercent: number | null;
}

/**
 * What the engine needs from the open publication to validate a conversion:
 * the spine (percent-encoded hrefs, reading order) and the chapter
 * documents.
 */
export interface ProgressSource {
  readonly spineHrefs: readonly string[];
  /** The parsed chapter document at a spine index, or null when unavailable. */
  readChapter(spineIndex: number): Promise<Document | null>;
}

/**
 * A converted restore target for the engine. Locator tiers carry the
 * serialized Readium locator; the percentage tier is resolved by the engine
 * against its positions list; null means the beginning of the book.
 */
export type RestoreTarget =
  | { tier: "exact" | "cfi" | "spine" | "spine-progression"; locator: string }
  | { tier: "book-percentage"; totalProgression: number }
  | null;

/** The serialized-locator JSON shape this module writes. */
export interface SerializedLocator {
  href: string;
  locations: {
    fragments?: string[];
    cssSelector?: string;
    progression?: number;
  };
  text?: {
    highlight: string;
    before?: string;
    after?: string;
  };
}

/** Quote lengths for the exact-location tier (Readium's TextQuoteAnchor). */
const QUOTE_SPAN = 64;
const QUOTE_CONTEXT = 40;

/**
 * Convert a foliate-era row into a restore target, walking the fallback
 * hierarchy. Every tier is validated against the actual EPUB via `source`;
 * failures fall through, and only a fully unlocatable locator-free row
 * degrades to the book percentage.
 */
export async function convertFoliateRow(
  row: FoliateProgressRow,
  source: ProgressSource,
): Promise<RestoreTarget> {
  const cfi = row.cfi?.trim() ? row.cfi : null;
  const chapterHref = row.chapterHref?.trim() ? row.chapterHref : null;

  const cfiParsed = cfi ? parseFoliateCfi(cfi) : null;
  const hrefSpineIndex = chapterHref ? matchSpineHref(chapterHref, source.spineHrefs) : null;

  if (cfiParsed) {
    const exact = await convertExact(cfiParsed, source);
    if (exact) return { tier: "exact", locator: JSON.stringify(exact) };

    const structural = await convertCfiStructure(cfiParsed, source);
    if (structural) return { tier: "cfi", locator: JSON.stringify(structural) };
  }

  if (cfiParsed || hrefSpineIndex !== null) {
    // Element/offset tier: the CFI's in-document steps against the spine
    // item the chapter href names (the CFI's own spine slot may disagree).
    const element = await convertSpineElement(cfiParsed, hrefSpineIndex, source);
    if (element) return { tier: "spine", locator: JSON.stringify(element) };

    const progressionSpineIndex = cfiParsed ? cfiParsed.spineIndex : hrefSpineIndex;
    const spine = convertSpineProgression(
      progressionSpineIndex,
      row.progressPercent,
      source.spineHrefs,
    );
    if (spine) return { tier: "spine-progression", locator: JSON.stringify(spine) };
  }

  // Book percentage: only for rows that never carried a locator.
  if (!cfi && !chapterHref) {
    const percent = row.progressPercent;
    const totalProgression =
      typeof percent === "number" && Number.isFinite(percent)
        ? Math.min(Math.max(percent / 100, 0), 1)
        : 0;
    return { tier: "book-percentage", totalProgression };
  }

  // A locator was present but nothing validated — restore to the beginning
  // rather than guessing a different position in a possibly different file.
  return null;
}

/** Index of `href` in the spine, matching foliate's OPF-relative form. */
export function matchSpineHref(href: string, spineHrefs: readonly string[]): number | null {
  const needle = href.replace(/^\.?\//, "");
  const exact = spineHrefs.findIndex((spine) => spine === needle);
  if (exact !== -1) return exact;
  const suffixed = spineHrefs.findIndex((spine) => spine.endsWith(`/${needle}`));
  return suffixed === -1 ? null : suffixed;
}

/** Tier 1: text node + character offset from the CFI, as a text quote. */
async function convertExact(
  cfi: FoliateCfi,
  source: ProgressSource,
): Promise<SerializedLocator | null> {
  const doc = await source.readChapter(cfi.spineIndex);
  if (!doc) return null;
  const terminal = cfi.docSteps[cfi.docSteps.length - 1];
  if (!terminal || !terminal.isText) return null;
  const node = resolveNode(doc, cfi.docSteps);
  if (!node || node.nodeType !== 3) return null;
  const text = node.textContent ?? "";
  const offset = Math.min(terminal.charOffset ?? 0, text.length);
  const highlight = text.slice(offset, offset + QUOTE_SPAN).trim();
  if (!highlight) return null;
  const spineHref = source.spineHrefs[cfi.spineIndex];
  if (spineHref === undefined) return null;
  return {
    href: spineHref,
    locations: {
      progression: itemProgression(doc, node),
    },
    text: {
      highlight,
      before: text.slice(Math.max(0, offset - QUOTE_CONTEXT), offset).trim(),
      after: text.slice(offset + QUOTE_SPAN, offset + QUOTE_SPAN + QUOTE_CONTEXT).trim(),
    },
  };
}

/** Tier 2: the CFI's element path, as a fragment id or CSS selector. */
async function convertCfiStructure(
  cfi: FoliateCfi,
  source: ProgressSource,
): Promise<SerializedLocator | null> {
  const doc = await source.readChapter(cfi.spineIndex);
  if (!doc) return null;
  const element = resolveElement(doc, cfi.docSteps);
  const spineHref = source.spineHrefs[cfi.spineIndex];
  if (spineHref === undefined) return null;
  return locateElement(element, spineHref, doc);
}

/**
 * Tier 3: spine item from the chapter href (or the CFI's spine slot), the
 * CFI's element path resolved inside it.
 */
async function convertSpineElement(
  cfi: FoliateCfi | null,
  hrefSpineIndex: number | null,
  source: ProgressSource,
): Promise<SerializedLocator | null> {
  const spineIndex = hrefSpineIndex ?? cfi?.spineIndex ?? null;
  if (spineIndex === null || spineIndex < 0 || spineIndex >= source.spineHrefs.length) {
    return null;
  }
  const doc = await source.readChapter(spineIndex);
  if (!doc || !cfi) return null;
  const element = resolveElement(doc, cfi.docSteps);
  const spineHref = source.spineHrefs[spineIndex];
  if (spineHref === undefined) return null;
  return locateElement(element, spineHref, doc);
}

/** Tier 4: the spine item itself, with a progression refined from the percent. */
function convertSpineProgression(
  spineIndex: number | null,
  progressPercent: number | null,
  spineHrefs: readonly string[],
): SerializedLocator | null {
  if (spineIndex === null || spineIndex < 0 || spineIndex >= spineHrefs.length) return null;
  const total = spineHrefs.length;
  const href = spineHrefs[spineIndex];
  if (href === undefined) return null;
  let progression = 0;
  if (typeof progressPercent === "number" && Number.isFinite(progressPercent) && total > 0) {
    // Inverse of the shell's spine-percent model:
    // percent = ((index + inSection) / total) * 100.
    progression = Math.min(Math.max((progressPercent / 100) * total - spineIndex, 0), 1);
  }
  return {
    href,
    locations: { progression },
  };
}

/** Locator for a resolved element: fragment id, then quote, then CSS path. */
function locateElement(
  element: Element | null,
  href: string,
  doc: Document,
): SerializedLocator | null {
  if (!element) return null;
  const id = element.getAttribute("id");
  if (id) {
    return { href, locations: { fragments: [id] } };
  }
  const text = (element.textContent ?? "").trim();
  if (text.length > 0) {
    const highlight = text.slice(0, QUOTE_SPAN);
    return {
      href,
      locations: {},
      text: {
        highlight,
        before: textBefore(doc, element, QUOTE_CONTEXT),
      },
    };
  }
  const selector = cssPath(element);
  if (selector) return { href, locations: { cssSelector: selector } };
  return null;
}

/** Short text immediately before `element` in document order. */
function textBefore(doc: Document, element: Element, maxChars: number): string {
  const range = doc.createRange();
  range.selectNode(element);
  range.setStart(doc, 0);
  const text = (range.toString() ?? "").trim();
  range.detach();
  return text.slice(Math.max(0, text.length - maxChars));
}

/** Minimal `:nth-of-type` chain from `element` to the document root. */
function cssPath(element: Element): string | null {
  const segments: string[] = [];
  let node: Element | null = element;
  while (node && node.nodeType === 1) {
    const tag = node.localName ?? node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (!parent) {
      segments.unshift(tag);
      break;
    }
    let position = 0;
    for (const sibling of parent.children) {
      if ((sibling.localName ?? sibling.tagName.toLowerCase()) === tag) {
        position += 1;
      }
      if (sibling === node) break;
    }
    segments.unshift(`${tag}:nth-of-type(${position})`);
    node = parent;
  }
  return segments.length > 0 ? `:root > ${segments.join(" > ")}` : null;
}

/**
 * Resolve the CFI's document steps against a parsed chapter document.
 * Tolerant of both child-indexing conventions (all child nodes, or elements
 * only): an even step prefers the element at `value/2 - 1` among element
 * children and falls back to the node at the same all-children index; an
 * odd step prefers the node at `(value-1)/2` among all child nodes.
 */
function resolveNode(doc: Document, steps: CfiStep[]): Node | null {
  let node: Node = doc;
  for (const step of steps) {
    const container: Node | null = node.nodeType === 9 ? doc : node;
    if (!container) return null;
    const children = container.childNodes;
    if (children.length === 0) return null;
    let index: number;
    if (step.isText) {
      index = (step.value - 1) / 2;
      if (index >= children.length) {
        // Fall back to element-only indexing for documents whose CFI counts
        // text nodes only among content nodes.
        const textIndex = Math.floor((step.value - 1) / 2);
        const elements = elementChildren(container);
        const elementAtTextIndex = elements[textIndex];
        if (elementAtTextIndex === undefined) return null;
        node = elementAtTextIndex;
        continue;
      }
    } else {
      index = step.value / 2 - 1;
      const elements = elementChildren(container);
      const elementAtIndex = elements[index];
      if (elementAtIndex !== undefined) {
        node = elementAtIndex;
        continue;
      }
      if (index >= children.length) return null;
    }
    const childAtIndex = children[index];
    if (childAtIndex === undefined) return null;
    node = childAtIndex;
  }
  return node;
}

/** The element step of the CFI resolved to an Element (never a text node). */
function resolveElement(doc: Document, steps: CfiStep[]): Element | null {
  // The terminal text step, if any, belongs to the exact tier.
  const elementSteps = steps[steps.length - 1]?.isText ? steps.slice(0, -1) : steps;
  if (elementSteps.length === 0) return null;
  const node = resolveNode(doc, elementSteps);
  if (node && node.nodeType === 1) return node as Element;
  return null;
}

function elementChildren(container: Node): Element[] {
  return Array.from(container.childNodes).filter((child): child is Element => child.nodeType === 1);
}

/** Coarse in-item progression of a node (0..1), by preceding text length. */
function itemProgression(doc: Document, node: Node): number {
  const range = doc.createRange();
  range.selectNode(node);
  range.setStart(doc, 0);
  const before = range.toString().length;
  range.detach();
  const total = (doc.documentElement?.textContent ?? "").length;
  if (total <= 0) return 0;
  return Math.min(Math.max(before / total, 0), 1);
}
