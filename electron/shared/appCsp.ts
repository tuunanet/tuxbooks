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
    // 'wasm-unsafe-eval' is required by the PDFium WASM in the PDF worker. The
    // blob: frames inherit this policy, so the blob: grants must not be stricter
    // than the frame CSP (contentPolicy.ts) already is.
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    "style-src 'self' tuxbooks: blob: 'unsafe-inline'",
    "img-src 'self' tuxbooks: data: blob:",
    "font-src 'self' tuxbooks: blob: data:",
    "connect-src 'self' tuxbooks:",
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "media-src 'self' tuxbooks: blob:",
    "object-src 'none'",
    "base-uri 'self' tuxbooks:",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ],
  development: [
    // Only the three Vite hot-reload overrides; every other production
    // directive carries over untouched.
    "script-src 'self' 'wasm-unsafe-eval' blob: 'unsafe-inline'",
    "style-src 'self' tuxbooks: blob: 'unsafe-inline'",
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
