import { describe, expect, it, vi } from "vitest";

import {
  ACTIVE_CONTENT_HTML_SNIPPETS,
  DANGEROUS_SCHEME_HREFS,
  EXTERNAL_RESOURCE_URLS,
  SCRIPTED_HTML_SNIPPETS,
  UNSUPPORTED_ENCODING_PROLOGS,
} from "./attackVectors";
import {
  classifyPublicationHref,
  declaredEncoding,
  insertFrameCspMeta,
  isPublicationResourceUrl,
  isSanitizableContentType,
  policyFetchClient,
  PUBLICATION_FRAME_CSP,
  publicationBaseUrl,
  sanitizeFrameDocument,
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

  it("returns a clean, well-formed document byte-identically", () => {
    const doc = xhtml(`<p>Hello <em>world</em></p><img src="img/pic.png" alt="p"/>`);
    expect(sanitizePublicationText(doc, true)).toBe(doc);
  });

  it("repairs a clean but not-well-formed manifest-XHTML document", () => {
    // The toolkit strict-parses manifest-XHTML, so a clean-but-sloppy
    // document (HTML-style unclosed img) cannot be returned raw: the fence
    // re-serializes it into XML the strict parse accepts. The HTML parser
    // represents a leading XML declaration as a comment; the repair keeps
    // it as such, which stays well-formed.
    const doc = xhtml(`<p>Hello <em>world</em></p><img src="img/pic.png" alt="p">`);
    const out = sanitizePublicationText(doc, true);
    // XML-safe serialization: void elements self-close and the strict
    // parser's sentinel never appears. The round-trip against a real XML
    // parse is pinned by the fixture regression suite (raw file input).
    expect(out).toContain('<img src="img/pic.png" alt="p" />');
    expect(out).toContain("<em>world</em>");
    expect(out).not.toContain("<parsererror");
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

  it("keeps the inert fallback of an unsupported object (E-2)", () => {
    // A reading system without support for an object's media type must render
    // its fallback (EPUB 3; the figure-gallery sample's spine is one document
    // whose only content is an object fallback). The object element and its
    // URL go, the inert children stay.
    const doc = xhtml(
      `<object data="gallery.xml" type="application/x-epub-figure-gallery">` +
        `<figure><img src="images/moon.jpg"/><figcaption>New Moon</figcaption></figure>` +
        `</object>`,
    );
    const out = sanitizePublicationText(doc, true);
    expect(out.toLowerCase()).not.toContain("<object");
    expect(out).not.toContain("gallery.xml");
    expect(out).toContain("<figure");
    expect(out).toContain(`src="images/moon.jpg"`);
    expect(out).toContain("New Moon");
  });

  it("does not leave object-only param children behind (E-2)", () => {
    const doc = xhtml(
      `<object data="page.xhtml" type="application/xhtml+xml"><param name="src" value="page.xhtml"/></object>`,
    );
    const out = sanitizePublicationText(doc, true);
    expect(out.toLowerCase()).not.toContain("<object");
    expect(out.toLowerCase()).not.toContain("<param");
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

describe("publication href classification (E-3)", () => {
  it.each(["chapter2.xhtml", "img/pic.png", "ch%20apter.xhtml#frag", "../styles/book.css"])(
    "treats %s as an in-book target",
    (href) => {
      expect(classifyPublicationHref(href)).toBe("in-book");
    },
  );

  it.each(["https://evil.example/x", "http://other.example/", "mailto:a@b.c", "tel:+12345"])(
    "treats %s as an external link to report",
    (href) => {
      expect(classifyPublicationHref(href)).toBe("external");
    },
  );

  it.each(DANGEROUS_SCHEME_HREFS)("treats %s as blocked", (href) => {
    expect(classifyPublicationHref(href)).toBe("blocked");
  });
});

describe("the publication fetch client (E-3)", () => {
  const base = publicationBaseUrl(7);

  function xhtmlResponse(body: string): Response {
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/xhtml+xml" },
    });
  }

  it("rejects request URLs outside the session base before fetching", async () => {
    const inner = vi.fn();
    const client = policyFetchClient(base, inner);
    for (const url of EXTERNAL_RESOURCE_URLS) {
      await expect(client(url)).rejects.toThrow();
    }
    expect(inner).not.toHaveBeenCalled();
  });

  it("passes session-base requests through to the inner fetch", async () => {
    const inner = vi.fn(() => Promise.resolve(new Response("ok")));
    const client = policyFetchClient(base, inner);
    const response = await client(`${base}chapter1.xhtml`);
    expect(await response.text()).toBe("ok");
    expect(inner).toHaveBeenCalledExactlyOnceWith(`${base}chapter1.xhtml`, undefined);
  });

  it("sanitizes document responses and injects the frame CSP", async () => {
    const doc = xhtml(`<p>x</p><script>alert(1)</script><a href="javascript:alert(1)">y</a>`);
    const client = policyFetchClient(base, () => Promise.resolve(xhtmlResponse(doc)));
    const text = await (await client(`${base}chapter1.xhtml`)).text();
    expect(text).toContain("<p>x</p>");
    expect(text.toLowerCase()).not.toContain("<script");
    expect(text.toLowerCase()).not.toContain("javascript:");
    expect(text).toContain('http-equiv="Content-Security-Policy"');
  });

  it("fences XML-declared XHTML XML-safely even when transported as text/html", async () => {
    // Real-world EPUBs keep XHTML content in .html members; the transport
    // maps those to text/html while the publication manifest still declares
    // application/xhtml+xml — the toolkit then strict-parses the member as
    // XML, so the injected CSP meta must be XML-self-closed.
    const doc = `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"/></head><body><p>x</p></body></html>`;
    const client = policyFetchClient(base, () =>
      Promise.resolve(new Response(doc, { status: 200, headers: { "content-type": "text/html" } })),
    );
    const text = await (await client(`${base}copyright.html`)).text();
    const reparsed = new DOMParser().parseFromString(text, "application/xhtml+xml");
    expect(reparsed.querySelector("parsererror")).toBeNull();
  });

  it("passes non-ok and non-document responses through untouched", async () => {
    const inner = vi.fn(
      async () => new Response("nope", { status: 404, headers: { "content-type": "text/html" } }),
    );
    const client = policyFetchClient(base, inner);
    const response = await client(`${base}missing.html`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("nope");
  });

  it("accepts URL and Request inputs and keeps the manifest href decoding", async () => {
    const seen: string[] = [];
    const doc = xhtml(`<p>x</p>`);
    const client = policyFetchClient(
      base,
      (input) => {
        seen.push(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        return Promise.resolve(
          new Response(doc, { status: 200, headers: { "content-type": "text/html" } }),
        );
      },
      (memberHref) => {
        // Manifest lookup receives the percent-decoded member href.
        expect(memberHref).toBe("chap ter 1.html");
        return "application/xhtml+xml";
      },
    );
    await client(`${base}chap%20ter%201.html`);
    expect(seen).toHaveLength(1);
  });

  it("returns the original bytes for a headless fragment the fence cannot scope", async () => {
    const raw = new TextEncoder().encode("<p>fragment</p>");
    const client = policyFetchClient(base, () =>
      Promise.resolve(
        new Response(raw.buffer as ArrayBuffer, {
          status: 200,
          headers: { "content-type": "application/xhtml+xml" },
        }),
      ),
    );
    const response = await client(`${base}fragment.xhtml`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes)).toEqual(Array.from(raw));
  });

  it("rejects requests outside the base via URL objects too", async () => {
    const client = policyFetchClient(base);
    await expect(client(new URL("https://evil.example/x.html"))).rejects.toThrow();
  });

  it.each(["image/png", "text/css", "font/woff2", "application/octet-stream"])(
    "leaves %s responses untouched",
    async (contentType) => {
      const body = "\u0000\u0001\u0002binary-ish";
      const client = policyFetchClient(
        base,
        async () => new Response(body, { headers: { "content-type": contentType } }),
      );
      const response = await client(`${base}asset.bin`);
      expect(await response.text()).toBe(body);
    },
  );

  it("keeps the response status of a sanitized document", async () => {
    const client = policyFetchClient(base, async () =>
      xhtmlResponse(xhtml(`<p>x</p><iframe src="page.xhtml"></iframe>`)),
    );
    const response = await client(`${base}chapter1.xhtml`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/xhtml+xml");
    expect((await response.text()).toLowerCase()).not.toContain("<iframe");
  });

  it.each(UNSUPPORTED_ENCODING_PROLOGS)(
    "fences a document whose prolog names an undecodable encoding (%s)",
    async (prolog) => {
      const doc = `${prolog}<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body><div onload="alert(1)">x</div></body></html>`;
      const client = policyFetchClient(base, async () => xhtmlResponse(doc));
      const text = await (await client(`${base}chapter1.xhtml`)).text();
      expect(text.toLowerCase()).not.toContain("onload=");
      expect(text).toContain(`http-equiv="Content-Security-Policy"`);
      expect(text).toContain("script-src blob:");
    },
  );
});

describe("the mounted-frame belt", () => {
  function mountedDoc(): Document {
    return new DOMParser().parseFromString(
      xhtml(
        `<p id="keep">t</p><script>content()</script>` +
          `<div onclick="x()"></div><iframe src="page.xhtml"></iframe>` +
          `<object data="gallery.xml" type="application/x-epub-figure-gallery">` +
          `<figure id="fallback-fig"><img src="images/moon.jpg"/></figure>` +
          `</object>` +
          `<svg data-readium="true"><script>toolkit()</script></svg>`,
      ),
      "application/xhtml+xml",
    );
  }

  it("removes content-authored active nodes but keeps the toolkit's own", () => {
    const doc = mountedDoc();
    sanitizeFrameDocument(doc);
    expect(doc.querySelector("#keep")).not.toBeNull();
    expect(doc.querySelectorAll("script")).toHaveLength(1);
    expect(doc.querySelector("script")?.textContent).toBe("toolkit()");
    expect(doc.querySelectorAll("iframe")).toHaveLength(0);
    expect(doc.querySelector("#keep")?.hasAttribute("onclick")).toBe(false);
    expect(doc.querySelectorAll("object")).toHaveLength(0);
    expect(doc.querySelector("#fallback-fig")).not.toBeNull();
  });

  it("removes refresh metas and external SVG use from content only", () => {
    const doc = new DOMParser().parseFromString(
      xhtml(
        `<meta http-equiv="refresh" content="1;url=https://evil.example/" />` +
          `<svg><use href="https://evil.example/x.svg#y" /></svg>`,
      ),
      "application/xhtml+xml",
    );
    sanitizeFrameDocument(doc);
    expect(doc.querySelectorAll("meta")).toHaveLength(0);
    expect(doc.querySelectorAll("use")).toHaveLength(0);
  });
});

describe("the publication base URL (E-4)", () => {
  it("is the opaque book-id resource space", () => {
    expect(publicationBaseUrl(7)).toBe("tuxbooks://book/7/");
  });

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects the unsafe book id %s",
    (bookId) => {
      expect(() => publicationBaseUrl(bookId)).toThrow();
    },
  );

  it("accepts only URLs under the same book's base", () => {
    const base = publicationBaseUrl(7);
    expect(isPublicationResourceUrl(`${base}chapter1.xhtml`, base)).toBe(true);
    expect(isPublicationResourceUrl(`${base}manifest.json`, base)).toBe(true);
    expect(isPublicationResourceUrl(publicationBaseUrl(8), base)).toBe(false);
    expect(isPublicationResourceUrl("https://evil.example/x", base)).toBe(false);
    expect(isPublicationResourceUrl("file:///etc/passwd", base)).toBe(false);
    expect(isPublicationResourceUrl("tuxbooks://cover/a.png", base)).toBe(false);
  });
});
