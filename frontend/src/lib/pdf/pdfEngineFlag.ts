/**
 * Selects the PDF engine behind the `PdfDocument`/`PdfPage` seam (ADR 0002).
 *
 * MuPDF stays the default until the flip ticket; PDFium is opt-in. Two inputs
 * choose it, in precedence order:
 *
 * - Runtime: `localStorage["tuxbooks.pdfEngine"] = "pdfium" | "mupdf"`. This
 *   overrides the build default, so one bundle can exercise either engine and
 *   the E2E suites can flip without a rebuild.
 * - Build time: `VITE_PDF_ENGINE=pdfium` at dev/build time.
 *
 * Anything else resolves to MuPDF, so the flag off leaves current behaviour
 * unchanged.
 */
export type PdfEngineId = "mupdf" | "pdfium";

export const PDF_ENGINE_STORAGE_KEY = "tuxbooks.pdfEngine";

/** Pure resolver over the two raw inputs; unit-tested without a DOM. */
export function resolvePdfEngine(
  stored: string | null | undefined,
  env: string | undefined,
): PdfEngineId {
  if (stored === "pdfium" || stored === "mupdf") return stored;
  return env === "pdfium" ? "pdfium" : "mupdf";
}

/** Resolves the active engine from runtime storage and the build environment. */
export function selectPdfEngine(): PdfEngineId {
  let stored: string | null = null;
  try {
    stored = globalThis.localStorage?.getItem(PDF_ENGINE_STORAGE_KEY) ?? null;
  } catch {
    // Storage can be unavailable (opaque origin, disabled storage): the
    // build-time default still applies.
  }
  return resolvePdfEngine(stored, import.meta.env.VITE_PDF_ENGINE as string | undefined);
}
