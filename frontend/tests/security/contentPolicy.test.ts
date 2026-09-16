import { describe, expect, it } from "vitest";

import { ACTIVE_CONTENT_HTML_SNIPPETS, SCRIPTED_HTML_SNIPPETS } from "./attackVectors";
import {
  declaredEncoding,
  insertFrameCspMeta,
  isSanitizableContentType,
  PUBLICATION_FRAME_CSP,
  sanitizePublicationText,
} from "@/lib/epub/contentPolicy";

const XHTML_PROLOG = `<?xml version="1.0" encoding="UTF-8"?>\n`;

function xhtml(body: string): string {
  return `${XHTML_PROLOG}<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>${body}</body></html>`;
}

describe("publication content sanitization (E-1, E-2)", () => {
  it.each(SCRIPTED_HTML_SNIPPETS)(
    "strips scripted content from a document containing %s",
    (snippet) => {
      const out = sanitizePublicationText(xhtml(`<p>before</p>${snippet}<p>after</p>`), true);
      expect(out).toContain("<p>before</p>");
      expect(out).toContain("<p>after</p>");
      expect(out.toLowerCase()).not.toContain("<script");
      expect(out.toLowerCase()).not.toContain("onerror=");
      expect(out.toLowerCase()).not.toContain("onload=");
      expect(out.toLowerCase()).not.toContain("javascript:");
      expect(out.toLowerCase()).not.toContain("vbscript:");
    },
  );

  it.each(ACTIVE_CONTENT_HTML_SNIPPETS)("neutralizes the active element %s", (snippet) => {
    const out = sanitizePublicationText(xhtml(`<p>keep</p>${snippet}`), true);
    expect(out).toContain("<p>keep</p>");
    expect(out.toLowerCase()).not.toContain("<object");
    expect(out.toLowerCase()).not.toContain("<embed");
    expect(out.toLowerCase()).not.toContain("<iframe");
    expect(out.toLowerCase()).not.toContain("<frame");
    expect(out.toLowerCase()).not.toContain("<base");
    expect(out.toLowerCase()).not.toContain('http-equiv="refresh"');
    expect(out.toLowerCase()).not.toContain("<use");
    expect(out.toLowerCase()).not.toContain("evil.example");
  });

  it("returns a clean document byte-identically", () => {
    const doc = xhtml(`<p>Hello <em>world</em></p><img src="img/pic.png" alt="p">`);
    expect(sanitizePublicationText(doc, true)).toBe(doc);
  });

  it("keeps publisher styling and images intact", () => {
    const doc = xhtml(
      `<style>p { color: red }</style><img src="img/pic.png" alt="pic"/><a href="chapter2.xhtml">next</a>`,
    );
    const out = sanitizePublicationText(doc, true);
    expect(out).toContain("p { color: red }");
    expect(out).toContain(`src="img/pic.png"`);
    expect(out).toContain(`href="chapter2.xhtml"`);
  });

  it("sanitizes HTML documents without an XML prolog", () => {
    const html = `<!DOCTYPE html><html><head><title>t</title></head><body><script>alert(1)</script><p>ok</p></body></html>`;
    const out = sanitizePublicationText(html, false);
    expect(out).toContain("<p>ok</p>");
    expect(out.toLowerCase()).not.toContain("<script");
  });

  it("keeps the doctype of a modified HTML document", () => {
    const html = `<!DOCTYPE html><html><head><title>t</title></head><body><script>x()</script><p>ok</p></body></html>`;
    expect(sanitizePublicationText(html, false)).toMatch(/^<!DOCTYPE html>/i);
  });

  it("leaves a fragment without a document untouched", () => {
    expect(sanitizePublicationText("<p>plain text only</p>", true)).toBe("<p>plain text only</p>");
  });
});

describe("frame CSP meta injection (E-1, E-2)", () => {
  it("injects the policy meta as the first head child of an XHTML document", () => {
    const out = insertFrameCspMeta(xhtml("<p>x</p>"), true);
    const meta = /<head[^>]*>(.*?)(<title)/is.exec(out)?.[1] ?? "";
    expect(meta).toContain('http-equiv="Content-Security-Policy"');
    expect(meta).toContain(PUBLICATION_FRAME_CSP);
    expect(out).toContain("<p>x</p>");
  });

  it("injects the policy meta into an HTML document without a head", () => {
    const out = insertFrameCspMeta("<html><body><p>x</p></body></html>", false);
    expect(out).toContain('http-equiv="Content-Security-Policy"');
    expect(out).toContain(PUBLICATION_FRAME_CSP);
  });

  it("leaves input without any document structure untouched", () => {
    expect(insertFrameCspMeta("<p>x</p>", true)).toBe("<p>x</p>");
  });
});

describe("the publication frame CSP", () => {
  it("blocks every script path except the toolkit's blob scripts", () => {
    const scriptSources = /script-src ([^;]+);/.exec(PUBLICATION_FRAME_CSP)?.[1] ?? "";
    expect(scriptSources).toBe("blob:");
  });

  it("keeps inline styling for the reading system but not for scripts", () => {
    const styleSources = /style-src ([^;]+);/.exec(PUBLICATION_FRAME_CSP)?.[1] ?? "";
    expect(styleSources).toContain("'unsafe-inline'");
    const scriptSources = /script-src ([^;]+);/.exec(PUBLICATION_FRAME_CSP)?.[1] ?? "";
    expect(scriptSources).not.toContain("'unsafe-inline'");
  });

  it("allows no object, frame, or connection targets", () => {
    expect(PUBLICATION_FRAME_CSP).toContain("object-src 'none'");
    expect(PUBLICATION_FRAME_CSP).toContain("frame-src 'none'");
    expect(PUBLICATION_FRAME_CSP).toContain("child-src 'none'");
    expect(PUBLICATION_FRAME_CSP).toContain("connect-src 'none'");
    expect(PUBLICATION_FRAME_CSP).toContain("default-src 'none'");
  });

  it("confines resource loads to the publication protocol", () => {
    for (const directive of ["img-src", "font-src", "media-src", "style-src"]) {
      const sources = new RegExp(`${directive} ([^;]+);`).exec(PUBLICATION_FRAME_CSP)?.[1] ?? "";
      expect(sources).toContain("tuxbooks:");
      expect(sources).not.toMatch(/https?:/);
      expect(sources).not.toContain("file:");
    }
  });
});

describe("sanitizable content types", () => {
  it.each([
    ["application/xhtml+xml", true],
    ["application/xhtml+xml; charset=utf-8", true],
    ["text/html", true],
    ["text/html;charset=iso-8859-1", true],
    ["image/svg+xml", true],
    ["text/css", false],
    ["image/png", false],
    ["application/octet-stream", false],
    [null, false],
    ["", false],
  ])("%s → %s", (contentType, expected) => {
    expect(isSanitizableContentType(contentType)).toBe(expected);
  });
});

describe("declared document encoding", () => {
  it.each([
    [`<?xml version="1.0" encoding="ISO-8859-1"?>\n<html></html>`, "ISO-8859-1"],
    [`<?xml version="1.0" encoding='utf-8'?><html/>`, "utf-8"],
    [`<?xml version="1.0"?><html/>`, null],
    [`<html><head></head></html>`, null],
    [`<?xml encoding="utf-16"?>`, "utf-16"],
  ])("%s → %s", (text, expected) => {
    expect(declaredEncoding(text)).toBe(expected);
  });

  it("ignores encoding declarations outside the prolog", () => {
    expect(declaredEncoding(`<html><head><meta charset="utf-8"></head></html>`)).toBeNull();
  });
});
