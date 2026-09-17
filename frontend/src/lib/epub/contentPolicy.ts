/**
 * The single EPUB content policy module (issue #82, E-1..E-5): every rule
 * that decides what publication content may do once the reader renders it.
 * The sidecar rejects scripted books before they open; this module fences
 * whatever still reaches a frame — sanitized document text, a strict frame
 * CSP intersected over the toolkit's own, a post-mount DOM belt, and href
 * classification for publication links. Pure functions over strings and
 * DOM so tests run in vitest without the Readium toolkit; the engine seam
 * (`readiumEngine.ts`) only wires them.
 */

/**
 * CSP enforced inside every rendered section document, injected as a meta
 * tag before the document parses. The toolkit injects its own permissive
 * frame CSP (`script-src … 'unsafe-inline'`, publication-base script files,
 * `object-src`/`child-src` from the publication base); browsers enforce all
 * policies together, so the stricter directive wins and this meta closes
 * every script and active-content path while leaving the toolkit's own
 * injected `blob:` scripts and inline ReadiumCSS styling functional.
 */
export const PUBLICATION_FRAME_CSP = [
  "default-src 'none'",
  "script-src blob:",
  "style-src tuxbooks: blob: data: 'unsafe-inline'",
  "img-src tuxbooks: blob: data:",
  "font-src tuxbooks: blob: data:",
  "media-src tuxbooks: blob: data:",
  "connect-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src blob:",
  "form-action 'none'",
  "base-uri tuxbooks:",
].join("; ");

const SANITIZABLE_CONTENT_TYPES = new Set(["application/xhtml+xml", "text/html", "image/svg+xml"]);

/** True when a response content type is document content we fence. */
export function isSanitizableContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  return SANITIZABLE_CONTENT_TYPES.has(contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "");
}

const XML_PROLOG = /^<\?xml[^>]*\?>/;

/** True when the document identifies as XML: declaration, XHTML doctype, or
 * the XHTML namespace in the head region. Publisher toolchains escape the
 * declaration into an HTML comment and drop declarations entirely, and the
 * transport content type disagrees with the manifest, so all three markers
 * matter. */
function looksLikeXml(text: string): boolean {
  const head = text.slice(0, 1024);
  return (
    XML_PROLOG.test(text.trimStart().slice(0, 128)) ||
    (head.includes("<!DOCTYPE") && head.toUpperCase().includes("XHTML")) ||
    /xmlns\s*=\s*["']http:\/\/www\.w3\.org\/1999\/xhtml["']/.test(head)
  );
}

/** The `encoding` declared by an XML prolog, or null. */
export function declaredEncoding(text: string): string | null {
  const prolog = XML_PROLOG.exec(text)?.[0];
  if (!prolog) return null;
  return /encoding\s*=\s*["']([^"']+)["']/.exec(prolog)?.[1] ?? null;
}

const ACTIVE_URL_ATTRIBUTES = new Set(["href", "src", "action", "formaction", "poster"]);
const SCRIPT_SCHEMES = ["javascript:", "vbscript:"];
/** Active-content elements removed wholesale (E-2) plus `base`/refresh metas. */
const REMOVED_ELEMENTS = "object, embed, iframe, frame, frameset, base";

function hasScriptScheme(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  return SCRIPT_SCHEMES.some((scheme) => trimmed.startsWith(scheme));
}

/**
 * Post-mount belt for a loaded section document (E-1, E-2): remove any
 * content-authored active node that survived to the live frame. The
 * toolkit's own injected nodes are marked `data-readium` and are left
 * alone — a forged marker can only preserve an inert node, since the
 * frame CSP and the sidecar's script gates run independently of this
 * sweep.
 */
export function sanitizeFrameDocument(doc: Document): void {
  const owned = (element: Element): boolean => {
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      if (node.hasAttribute("data-readium")) return true;
    }
    return false;
  };
  for (const active of doc.querySelectorAll(REMOVED_ELEMENTS + ", script")) {
    if (!owned(active)) active.remove();
  }
  for (const meta of doc.querySelectorAll("meta[http-equiv]")) {
    if (!owned(meta) && meta.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh") {
      meta.remove();
    }
  }
  for (const use of doc.querySelectorAll("use")) {
    if (owned(use)) continue;
    const target = use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? "";
    if (!target.trim().startsWith("#")) use.remove();
  }
  for (const element of doc.querySelectorAll("*")) {
    if (!owned(element)) scrubActiveAttributes(element);
  }
}

/**
 * Strip active content from a publication document: script elements
 * anywhere in the tree (XHTML, SVG, inline or sourced), active-content
 * elements (`object`/`embed`/`iframe` and kin), inline event handler
 * attributes, and script-scheme URLs on URL-bearing attributes. Hostile
 * "XHTML" is frequently not well-formed XML, so a failed XML parse falls
 * back to HTML parsing — the same fallback the reading engine itself
 * applies — and the fence holds for sloppy markup. Documents with nothing
 * to strip are returned untouched so clean books keep their exact bytes.
 */
export function sanitizePublicationText(text: string, isXml: boolean): string {
  if (isXml) {
    const xml = new DOMParser().parseFromString(text, "application/xhtml+xml");
    if (xml.querySelector("parsererror") === null && xml.documentElement !== null) {
      return stripActiveContent(xml, true) ?? text;
    }
    // Sloppy manifest-XHTML (unclosed tags, named HTML entities): the HTML
    // parser repairs it, and the HTML parser already puts every element in
    // the XHTML namespace, so XMLSerializer emits well-formed XML the
    // toolkit's strict parse accepts - named entities decode to characters
    // here, which is what makes entity-laden chapters renderable at all.
    // Re-serialize even when nothing was stripped: the raw bytes fail the
    // strict parse, so "unchanged" is not an option for this class.
    const html = new DOMParser().parseFromString(text, "text/html");
    for (const element of html.querySelectorAll("*")) {
      // The HTML parser both namespaces every element and keeps a literal
      // xmlns attribute; XMLSerializer emits both and strict XML rejects
      // the duplicate declaration. The namespace survives on the element.
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name === "xmlns" || attribute.name.startsWith("xmlns:")) {
          element.removeAttribute(attribute.name);
        }
      }
    }
    return stripActiveContent(html, true) ?? serializeXml(html);
  }
  const html = new DOMParser().parseFromString(text, "text/html");
  return stripActiveContent(html, false) ?? text;
}

function stripActiveContent(doc: Document, isXml: boolean): string | null {
  let changed = false;
  for (const script of doc.querySelectorAll("script")) {
    script.remove();
    changed = true;
  }
  for (const active of doc.querySelectorAll(REMOVED_ELEMENTS)) {
    active.remove();
    changed = true;
  }
  for (const meta of doc.querySelectorAll("meta[http-equiv]")) {
    if (meta.getAttribute("http-equiv")?.trim().toLowerCase() === "refresh") {
      meta.remove();
      changed = true;
    }
  }
  for (const use of doc.querySelectorAll("use")) {
    const target = use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? "";
    if (target.trim().startsWith("#")) continue;
    use.remove();
    changed = true;
  }
  for (const element of doc.querySelectorAll("*")) {
    changed = scrubActiveAttributes(element) || changed;
  }
  if (!changed) return null;
  return isXml ? serializeXml(doc) : serializeHtml(doc);
}

/** Removes handler and script-scheme attributes; true when anything went. */
function scrubActiveAttributes(element: Element): boolean {
  let changed = false;
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (name.startsWith("on")) {
      element.removeAttribute(attribute.name);
      changed = true;
    } else if (ACTIVE_URL_ATTRIBUTES.has(attribute.localName) && hasScriptScheme(attribute.value)) {
      element.removeAttribute(attribute.name);
      changed = true;
    }
  }
  return changed;
}

/**
 * Inject the publication frame CSP meta as the first `<head>` child so it
 * applies from the first parsed byte of the frame document. Documents
 * without a head fall back to just inside `<html>`; unstructured fragments
 * are returned untouched.
 */
export function insertFrameCspMeta(html: string, isXml: boolean): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PUBLICATION_FRAME_CSP}"${isXml ? " /" : ""}>`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (head) => `${head}${meta}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (tag) => `${tag}${meta}`);
  }
  return html;
}

function serializeXml(doc: Document): string {
  return new XMLSerializer().serializeToString(doc);
}

function serializeHtml(doc: Document): string {
  const doctype = doc.doctype;
  const prefix =
    doctype === null
      ? ""
      : `<!DOCTYPE ${doctype.name}${doctype.publicId ? ` PUBLIC "${doctype.publicId}"` : ""}${
          doctype.systemId ? ` "${doctype.systemId}"` : ""
        }>`;
  return `${prefix}${doc.documentElement.outerHTML}`;
}

/**
 * The only URL space the engine ever forms for a publication (E-4): an
 * opaque book id on the resource protocol, never a filesystem path.
 */
export function publicationBaseUrl(bookId: number): string {
  if (!Number.isSafeInteger(bookId) || bookId <= 0) {
    throw new Error(`invalid book id: ${bookId}`);
  }
  return `tuxbooks://book/${bookId}/`;
}

/** True when `rawUrl` resolves inside the publication rooted at `baseUrl`. */
export function isPublicationResourceUrl(rawUrl: string, baseUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const base = new URL(baseUrl);
    if (url.protocol !== base.protocol || url.host !== base.host) return false;
    return url.pathname.startsWith(base.pathname);
  } catch {
    return false;
  }
}

export type PublicationHrefClass = "in-book" | "external" | "blocked";

const EXTERNAL_HREF_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * What a link inside publication content may do (E-3): relative targets
 * are the engine's own navigation, the web/mail/tel schemes are reported
 * external links that are never navigated, and every other absolute target
 * (file:, javascript:, data:, blob:, custom protocols, protocol-relative)
 * is blocked outright.
 */
export function classifyPublicationHref(href: string): PublicationHrefClass {
  const trimmed = href.trim();
  if (trimmed.startsWith("//")) return "blocked";
  const scheme = /^[a-z][a-z0-9+.-]*:/i.exec(trimmed)?.[0]?.toLowerCase();
  if (scheme === undefined) return "in-book";
  return EXTERNAL_HREF_SCHEMES.has(scheme) ? "external" : "blocked";
}

type FetchInput = string | URL | Request;

/**
 * The fetch client the publication's `HttpFetcher` runs through (E-3).
 * Every request the toolkit issues for a resource must stay inside the
 * session base, and every document response is fenced
 * (`sanitizePublicationText` + frame CSP meta) before anything can parse
 * it — including documents whose prolog names an encoding the platform
 * refuses, which decode through a byte-preservingly safe fallback
 * (`fenceDocumentResponse`). Non-document responses pass through
 * byte-identically; failures in the fencing pipeline propagate, so the
 * frame fails closed instead of rendering unfenced bytes.
 */
export function policyFetchClient(
  baseUrl: string,
  fetchImpl?: (input: FetchInput, init?: RequestInit) => Promise<Response>,
  mediaTypeFor?: (memberHref: string) => string | null,
): (input: FetchInput, init?: RequestInit) => Promise<Response> {
  const inner =
    fetchImpl ??
    ((input: FetchInput, init?: RequestInit) => fetch(input as RequestInfo | URL, init));
  return async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isPublicationResourceUrl(raw, baseUrl)) {
      throw new Error(`publication request outside the session base: ${raw}`);
    }
    const response = await inner(input, init);
    const contentType = response.headers.get("content-type");
    if (!response.ok || !isSanitizableContentType(contentType)) return response;
    // The manifest media type is what the toolkit's strict parse follows,
    // not the transport header: real books keep application/xhtml+xml
    // content in .html members, which the resource protocol serves as
    // text/html. Resolve through the publication manifest when available.
    const memberHref = safeMemberHref(raw, baseUrl);
    const declared = memberHref === null ? null : (mediaTypeFor?.(memberHref) ?? null);
    return fenceDocumentResponse(response, declared);
  };
}

/** The manifest-relative href a publication request addresses, or null. */
function safeMemberHref(raw: string, baseUrl: string): string | null {
  if (!raw.startsWith(baseUrl)) return null;
  const rest = raw.slice(baseUrl.length);
  try {
    return decodeURIComponent(rest);
  } catch {
    return rest;
  }
}

/**
 * Sanitize and CSP-fence one document response. The prolog's declared
 * encoding decides the decoder; a label the platform refuses (utf-7 and
 * the replacement bucket) falls back to windows-1252, which decodes bytes
 * byte-preservingly so the fence still applies — the toolkit's own frame
 * CSP allows inline scripts, so unfenced bytes are executable content.
 * Clean documents keep their original bytes; failures propagate so a frame
 * fails closed instead of rendering unfenced markup.
 */
async function fenceDocumentResponse(
  response: Response,
  declaredType: string | null,
): Promise<Response> {
  const bytes = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") ?? "";
  const sniffable = new TextDecoder("latin1").decode(bytes.slice(0, 200));
  const decoder = safeDecoder(declaredEncoding(sniffable) ?? "utf-8");
  const text = decoder.decode(bytes);
  const isXml =
    declaredType !== null
      ? declaredType.includes("xhtml") || declaredType.includes("svg")
      : contentType.includes("xhtml") || contentType.includes("svg") || looksLikeXml(text);
  const sanitized = sanitizePublicationText(text, isXml);
  const fenced = insertFrameCspMeta(sanitized, isXml);
  if (fenced === text) {
    return new Response(bytes, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders(response),
    });
  }
  const output = isXml
    ? declareUtf8Prolog(fenced)
    : fenced.replace(/<meta[^>]+charset[^>]*>/gi, `<meta charset="utf-8">`);
  return new Response(output, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders(response),
  });
}

function safeDecoder(label: string): TextDecoder {
  try {
    return new TextDecoder(label);
  } catch {
    return new TextDecoder("windows-1252");
  }
}

function responseHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return headers;
}

const XML_PROLOG_ENCODING = /^(<\?xml[^>]*?)encoding\s*=\s*["'][^"']+["']/i;

/** A modified document is re-emitted as UTF-8; its prolog must say so. */
function declareUtf8Prolog(text: string): string {
  if (!/^<\?xml/i.test(text)) return text;
  return text.replace(XML_PROLOG_ENCODING, `$1encoding="UTF-8"`);
}
