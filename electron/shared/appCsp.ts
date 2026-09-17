/**
 * The application UI's Content-Security-Policy (issue #85, X-2), served as a
 * response header on every `app://bundle` document (packaged and E2E load
 * path) and on the Vite dev server. One builder, two variants: the shipped
 * policy allows only what the app shell and the reader engines need; the dev
 * variant adds the three allowances Vite's hot reload requires (the inline
 * React-refresh preamble, HMR style injection, the HMR websocket).
 *
 * The reader's own stricter frame CSP lives in
 * `frontend/src/lib/epub/contentPolicy.ts` (issue #82); the two intersect
 * inside publication frames. blob: frames inherit the embedding document's
 * policy, so this policy also carries the reader-frame grants (blob:
 * toolkit scripts, ReadiumCSS styles, the publication base URI), the
 * intersection must not be stricter than what the frame CSP already
 * grants, or the reader renders broken.
 */

export type AppUiCspVariant = "production" | "development";

const DIRECTIVES: Record<AppUiCspVariant, string[]> = {
  production: [
    "default-src 'none'",
    // 'wasm-unsafe-eval' is required by the MuPDF WASM (instantiated inside
    // the PDF worker, which inherits this policy); no inline or eval script
    // execution is allowed. blob: is the reader toolkit's own injected
    // section scripts (marked data-readium, inside the sandboxed frames);
    // this policy is inherited by the blob: frames, so it must not be
    // stricter there than the frame CSP (contentPolicy.ts) already is.
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    // 'unsafe-inline' styles and blob: stylesheets are ReadiumCSS inside
    // the reader frames (same inheritance); styles are not script
    // execution, and the frame CSP grants them already.
    "style-src 'self' blob: 'unsafe-inline'",
    // Covers resolve over the resource protocol; data: and blob: cover
    // bundled icons, reader fonts/media, and locally generated images.
    "img-src 'self' tuxbooks: data: blob:",
    "font-src 'self' tuxbooks: blob: data:",
    // The app page and the PDF worker fetch book bytes over tuxbooks://.
    "connect-src 'self' tuxbooks:",
    // The EPUB reader mounts sandboxed section frames from blob: URLs.
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "media-src 'self' tuxbooks: blob:",
    "object-src 'none'",
    // Reader frames set their document base to the publication root
    // (tuxbooks://book/<id>/) for relative resource resolution.
    "base-uri 'self' tuxbooks:",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ],
  development: [
    // Overrides of the production list: the builder keeps every production
    // directive not named here, so the reader-frame grants (blob: scripts
    // and styles, tuxbooks: media, the frame/base allowances) carry into
    // dev untouched. Only the three Vite hot-reload needs are added:
    // the React-refresh preamble is an inline module script, HMR injects
    // <style> elements, and the HMR socket is a websocket.
    "script-src 'self' 'wasm-unsafe-eval' blob: 'unsafe-inline'",
    "style-src 'self' blob: 'unsafe-inline'",
    "connect-src 'self' tuxbooks: ws:",
  ],
};

/** The serialized CSP for one variant. */
export function appUiCsp(variant: AppUiCspVariant = "production"): string {
  const [base, overrides] =
    variant === "production"
      ? [DIRECTIVES.production, null]
      : [DIRECTIVES.production, DIRECTIVES.development];
  if (!overrides) return base.join("; ");
  const overridden = new Set(overrides.map((directive) => directive.split(" ")[0]));
  return [
    ...base.filter((directive) => !overridden.has(directive.split(" ")[0])),
    ...overrides,
  ].join("; ");
}

/** The production policy as a constant (the app:// response header value). */
export const APP_UI_CSP = appUiCsp("production");
