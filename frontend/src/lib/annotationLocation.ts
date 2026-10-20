import type { Annotation } from "@/types/domain";

/**
 * A readable location for an annotation when no table of contents is loaded.
 * PDF annotations carry a page number; EPUB annotations carry a spine href,
 * which is shortened to a human-readable chapter stem.
 */
export function annotationLocationLabel(annotation: Annotation): string {
  if (annotation.pageNumber !== null) return `Page ${annotation.pageNumber}`;
  if (annotation.chapterHref) {
    const path = annotation.chapterHref.split("#")[0] ?? annotation.chapterHref;
    const file = path.split("/").pop() ?? path;
    const stem = file
      .replace(/\.[^.]+$/, "")
      .replaceAll(/[-_]+/g, " ")
      .trim();
    if (stem !== "") return stem.charAt(0).toUpperCase() + stem.slice(1);
  }
  return annotation.kind === "bookmark" ? "Bookmark" : "Highlight";
}
