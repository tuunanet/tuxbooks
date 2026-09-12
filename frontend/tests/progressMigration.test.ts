import { describe, expect, it } from "vitest";
import {
  EPUB_PROGRESS_SCHEMA_VERSION,
  convertFoliateRow,
  matchSpineHref,
  parseFoliateCfi,
  type FoliateProgressRow,
  type ProgressSource,
} from "@/lib/epub/progressMigration";

/**
 * Progress-migration adapter tests (docs/EPUB.md). The chapter documents
 * come from synthetic DOM (the adapter's ProgressSource seam), mirroring the
 * real conversion path; the end-to-end conversion against the real
 * minimal.epub fixture — including the captured foliate CFIs the old app
 * wrote — is pinned by the progress-migration E2E suite.
 */

const SPINE = ["OEBPS/chapter1.xhtml", "OEBPS/chapter2.xhtml", "OEBPS/chapter3.xhtml"];

/** One-paragraph chapter with a stable phrase and known text layout. */
function chapterDoc(paragraphs: string[]): Document {
  const body = paragraphs.map((text) => `<p>${text}</p>`).join("");
  const html = `<!DOCTYPE html><html><head><title>t</title></head><body><h1>Heading</h1>${body}</body></html>`;
  return new DOMParser().parseFromString(html, "application/xhtml+xml");
}

function makeSource(chapters: (Document | null)[]): ProgressSource & { reads: number[] } {
  const reads: number[] = [];
  return {
    reads,
    spineHrefs: SPINE,
    readChapter: (index) => {
      reads.push(index);
      return Promise.resolve(chapters[index] ?? null);
    },
  };
}

function row(overrides: Partial<FoliateProgressRow> = {}): FoliateProgressRow {
  return { cfi: null, chapterHref: null, progressPercent: null, ...overrides };
}

describe("parseFoliateCfi", () => {
  it("parses point CFIs: spine item, element path, text offset", () => {
    const parsed = parseFoliateCfi("epubcfi(/6/2!/4/2/1:62)");
    expect(parsed).toEqual({
      spineIndex: 0,
      docSteps: [
        { value: 4, isText: false },
        { value: 2, isText: false },
        { value: 1, isText: true, charOffset: 62 },
      ],
    });
  });

  it("parses range CFIs from the start boundary", () => {
    // The exact shape the old app wrote on minimal.epub (E2E seeds these).
    const parsed = parseFoliateCfi("epubcfi(/6/4!/4,/2,/6/1:62)");
    expect(parsed).not.toBeNull();
    expect(parsed?.spineIndex).toBe(1);
    expect(parsed?.docSteps).toEqual([{ value: 4, isText: false }]);
  });

  it("skips bracket id assertions foliate emits", () => {
    const parsed = parseFoliateCfi("epubcfi(/6/4[chapter2]!/4[body]/2[para],/1:0,/1:5)");
    expect(parsed?.spineIndex).toBe(1);
    expect(parsed?.docSteps).toEqual([
      { value: 4, isText: false },
      { value: 2, isText: false },
    ]);
  });

  it("rejects garbage without throwing", () => {
    for (const garbage of [
      "",
      "not a cfi",
      "epubcfi()",
      "epubcfi(/6/2)",
      "epubcfi(/6/2!",
      "epubcfi(/6/1!/4)",
      "epubcfi(/6/x!/4)",
      "epubcfi(/6/2!/4:/x)",
      "epubcfi(/6/99999999999999999999!/4)",
    ]) {
      expect(() => parseFoliateCfi(garbage)).not.toThrow();
      expect(parseFoliateCfi(garbage)).toBeNull();
    }
  });
});

describe("convertFoliateRow fallback hierarchy", () => {
  it("tier exact: text node + offset converts to a text-quote locator", async () => {
    const doc = chapterDoc(["The quick brown fox jumps over the lazy dog near the riverbank."]);
    const source = makeSource([doc]);
    // html(/4) → body(/4) → p(/4) → text node(/1), offset inside "quick".
    const parsed = parseFoliateCfi("epubcfi(/6/2!/4/4/4/1:4)");
    expect(parsed).not.toBeNull();
    const target = await convertFoliateRow(row({ cfi: "epubcfi(/6/2!/4/4/4/1:4)" }), source);
    expect(target?.tier).toBe("exact");
    if (target?.tier !== "exact") return;
    const locator = JSON.parse(target.locator) as {
      href: string;
      text?: { highlight?: string; before?: string };
    };
    expect(locator.href).toBe("OEBPS/chapter1.xhtml");
    expect(locator.text?.highlight).toContain("quick");
    expect(locator.text?.before?.length ?? 0).toBeGreaterThan(0);
  });

  it("tier cfi: an element path resolves to a fragment id", async () => {
    const doc = chapterDoc(["Some text."]);
    const heading = doc.querySelector("h1");
    heading?.setAttribute("id", "ch1-title");
    const source = makeSource([doc]);
    // html(/4) → body(/4) → h1(/2).
    const target = await convertFoliateRow(row({ cfi: "epubcfi(/6/2!/4/4/2)" }), source);
    expect(target?.tier).toBe("cfi");
    if (target?.tier !== "cfi") return;
    const locator = JSON.parse(target.locator) as { locations: { fragments?: string[] } };
    expect(locator.locations.fragments).toEqual(["ch1-title"]);
  });

  it("tier cfi: an element without an id falls back to a text quote", async () => {
    const doc = chapterDoc(["A distinctive paragraph body for the quote tier."]);
    const source = makeSource([doc]);
    // html(/4) → body(/4) → p(/4).
    const target = await convertFoliateRow(row({ cfi: "epubcfi(/6/2!/4/4/4)" }), source);
    expect(target?.tier).toBe("cfi");
    if (target?.tier !== "cfi") return;
    const locator = JSON.parse(target.locator) as { text?: { highlight?: string } };
    expect(locator.text?.highlight).toContain("distinctive");
  });

  it("tier spine: chapter href rescues a CFI whose spine slot is wrong", async () => {
    const doc = chapterDoc(["Body text."]);
    const source = makeSource([null, doc]);
    const target = await convertFoliateRow(
      row({ cfi: "epubcfi(/6/2!/4/4/4)", chapterHref: "chapter2.xhtml" }),
      source,
    );
    expect(target?.tier).toBe("spine");
    if (target?.tier !== "spine") return;
    const locator = JSON.parse(target.locator) as { href: string };
    expect(locator.href).toBe("OEBPS/chapter2.xhtml");
  });

  it("tier spine-progression: a bare chapter href restores that section from the percent", async () => {
    const source = makeSource([null, null, null]);
    const target = await convertFoliateRow(
      row({ chapterHref: "chapter3.xhtml", progressPercent: 75 }),
      source,
    );
    expect(target?.tier).toBe("spine-progression");
    if (target?.tier !== "spine-progression") return;
    const locator = JSON.parse(target.locator) as {
      href: string;
      locations: { progression: number };
    };
    expect(locator.href).toBe("OEBPS/chapter3.xhtml");
    // percent 75 of 3 sections, section index 2: (0.75 * 3) - 2 = 0.25.
    expect(locator.locations.progression).toBeCloseTo(0.25, 5);
  });

  it("tier book-percentage: only locator-free rows fall back to the fraction", async () => {
    const source = makeSource([]);
    const target = await convertFoliateRow(row({ progressPercent: 50 }), source);
    expect(target).toEqual({ tier: "book-percentage", totalProgression: 0.5 });

    // A locator-bearing row with nothing resolvable NEVER trusts its stale
    // percentage against a different file — it degrades to the beginning.
    const stale = await convertFoliateRow(
      row({ cfi: "epubcfi(/6/999!/4/2/1:0)", chapterHref: "gone.xhtml", progressPercent: 50 }),
      source,
    );
    expect(stale).toBeNull();
  });

  it("reads only the chapters the tiers need", async () => {
    const source = makeSource([chapterDoc(["Body."])]);
    // The exact tier reads the chapter first (a point-element CFI has no
    // text terminal), then the cfi tier reads it again for the element.
    await convertFoliateRow(row({ cfi: "epubcfi(/6/2!/4/4/4)" }), source);
    expect(source.reads).toEqual([0, 0]);
  });

  it("degrades to the beginning when the chapter cannot be read", async () => {
    const source = makeSource([]); // missing EPUB / unavailable chapters
    const target = await convertFoliateRow(
      row({ cfi: "epubcfi(/6/2!/4/4/4)", chapterHref: "chapter1.xhtml" }),
      source,
    );
    expect(target?.tier).toBe("spine-progression");
  });
});

describe("matchSpineHref", () => {
  it("matches exact and OPF-relative hrefs", () => {
    expect(matchSpineHref("OEBPS/chapter2.xhtml", SPINE)).toBe(1);
    expect(matchSpineHref("chapter2.xhtml", SPINE)).toBe(1);
    expect(matchSpineHref("./chapter3.xhtml", SPINE)).toBe(2);
    expect(matchSpineHref("gone.xhtml", SPINE)).toBeNull();
  });
});

describe("schema version", () => {
  it("is exported for the reader's save payloads", () => {
    expect(EPUB_PROGRESS_SCHEMA_VERSION).toBe(2);
  });
});
