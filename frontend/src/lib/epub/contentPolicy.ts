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
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        changed = true;
      } else if (
        ACTIVE_URL_ATTRIBUTES.has(attribute.localName) &&
        hasScriptScheme(attribute.value)
      ) {
        element.removeAttribute(attribute.name);
        changed = true;
      }
    }
  }
  if (!changed) return null;
  return isXml ? serializeXml(doc) : serializeHtml(doc);
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
