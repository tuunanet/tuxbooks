/**
 * Stand-in constants for the reader stage while a document is still loading —
 * the PDF reader uses this count until the MuPDF document reports the real
 * one. The EPUB reader's session already carries the real page count.
 */

export const PDF_PLACEHOLDER_PAGE_COUNT = 24;
