import { describe, expect, it, vi } from "vitest";

import { SECURITY_CORPUS } from "./index";
import { HOSTILE_EPUB_CORPUS } from "./hostileEpub";
import {
  ACTIVE_CONTENT_HTML_SNIPPETS,
  BAD_BOOK_IDS,
  DANGEROUS_SCHEME_HREFS,
  ENCODED_TRAVERSAL_MEMBERS,
  EXTERNAL_RESOURCE_URLS,
  SCRIPTED_HTML_SNIPPETS,
  TRAVERSAL_MEMBER_PATHS,
  UNSUPPORTED_ENCODING_PROLOGS,
} from "../attackVectors";
import {
  classifyPublicationHref,
  PUBLICATION_FRAME_CSP,
  policyFetchClient,
  publicationBaseUrl,
  sanitizePublicationText,
} from "@/lib/epub/contentPolicy";

describe("the security corpus index (issue #87)", () => {
  it("covers every invariant group of the issue body", () => {
    const invariants = new Set(SECURITY_CORPUS.map((row) => row.invariant));
    for (const id of [
      "E-1",
      "E-2",
      "E-3",
      "E-4",
      "E-5",
      "R-1",
      "R-2",
      "R-3",
      "T-1",
      "T-2",
      "T-3",
      "T-4",
      "T-5",
      "T-6",
      "T-7",
      "W-8",
      "W-9",
      "W-2/W-3/W-5",
      "P-1",
    ]) {
      expect(invariants, `${id} must have a corpus row`).toContain(id);
    }
    for (const row of SECURITY_CORPUS) {
      expect(row.vectors, `${row.invariant} vectors`).not.toBe("");
      expect(row.enforcedBy.length, `${row.invariant} enforcement pointers`).toBeGreaterThan(0);
    }
  });

  it("keeps every vector array populated", () => {
    for (const [name, vectors] of Object.entries({
      SCRIPTED_HTML_SNIPPETS,
      ACTIVE_CONTENT_HTML_SNIPPETS,
      EXTERNAL_RESOURCE_URLS,
      DANGEROUS_SCHEME_HREFS,
      TRAVERSAL_MEMBER_PATHS,
      ENCODED_TRAVERSAL_MEMBERS,
      BAD_BOOK_IDS,
      UNSUPPORTED_ENCODING_PROLOGS,
    })) {
      expect(vectors.length, `${name} must keep its vectors`).toBeGreaterThan(0);
    }
  });

  it("carries a hostile EPUB fixture for every content invariant", () => {
    const invariants = new Set(HOSTILE_EPUB_CORPUS.map((fixture) => fixture.invariant));
    for (const id of ["E-1", "E-2", "E-3", "E-4"]) {
      expect(invariants, `${id} hostile EPUB fixture`).toContain(id);
    }
    for (const fixture of HOSTILE_EPUB_CORPUS) {
      expect(fixture.bytes.length).toBeGreaterThan(0);
      expect(fixture.bytes[0]).toBe(0x50);
      expect(fixture.chapter.length).toBeGreaterThan(0);
    }
  });
});

describe("hostile EPUB corpus documents fail closed at the publication fence", () => {
  it.each(HOSTILE_EPUB_CORPUS)("fences the $invariant fixture $name", ({ chapter }) => {
    const out = sanitizePublicationText(chapter, true);
    const lowered = out.toLowerCase();
    expect(lowered).not.toContain("<script");
    expect(lowered).not.toContain("<iframe");
    expect(lowered).not.toContain("<object");
    expect(lowered).not.toContain("<embed");
    expect(lowered).not.toContain("javascript:");
    expect(lowered).not.toContain("onclick=");
    expect(lowered).not.toContain("onload=");
    expect(out).toContain("text");
  });

  it.each(HOSTILE_EPUB_CORPUS)(
    "rejects the external targets of $name before any fetch",
    async ({ chapter }) => {
      const inner = vi.fn();
      const base = publicationBaseUrl(1);
      const client = policyFetchClient(base, inner);
      const urls = /(?:src|href)="([^"]+)"/g;
      for (const match of chapter.matchAll(urls)) {
        const target = match[1] ?? "";
        if (/^https?:/i.test(target)) {
          await expect(client(target)).rejects.toThrow();
        }
      }
      expect(inner).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["file:///home/user/.ssh/id_rsa", "blocked"],
    ["tuxbooks://book/999/chapter1.xhtml", "blocked"],
    ["https://evil.example/track.png", "external"],
  ])("classifies the path-probe targets: %s → %s", (href, expected) => {
    expect(classifyPublicationHref(href)).toBe(expected);
  });

  it("never lets the corpus escape the publication CSP", () => {
    for (const directive of ["img-src", "style-src", "connect-src", "frame-src"]) {
      const sources = new RegExp(`${directive} ([^;]+);`).exec(PUBLICATION_FRAME_CSP)?.[1] ?? "";
      expect(sources).not.toMatch(/https?:/);
      expect(sources).not.toContain("file:");
    }
  });
});
