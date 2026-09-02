/**
 * Stand-in constants for the reader stage while a document is still loading —
 * the PDF reader uses this count until PDF.js reports the real one. The EPUB
 * reader loads through the foliate-js engine and has no placeholder anymore.
 */

export const PDF_PLACEHOLDER_PAGE_COUNT = 24;
