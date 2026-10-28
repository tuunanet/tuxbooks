import type { RefObject } from "react";
import { useShortcut } from "@/lib/shortcuts";
import type { ReaderPaging } from "./useReaderPaging";

interface UsePagingKeysInput {
  isPdf: boolean;
  isEpub: boolean;
  presentation: boolean;
  bookMode: boolean;
  paging: ReaderPaging;
  contentRef: RefObject<HTMLElement | null>;
}

function scrollViewport(contentRef: RefObject<HTMLElement | null>, direction: 1 | -1) {
  const container = contentRef.current;
  if (container) container.scrollTop += direction * container.clientHeight * 0.9;
}

/**
 * The keyboard side of paging. Arrow/space/PageUp/PageDown are PDF behaviors:
 * they are not registered while an EPUB is open, where EpubReader owns those
 * combos outright regardless of registration order, because a shell
 * percentage step with no page count would clamp straight to the beginning or
 * end of the document.
 */
export function usePagingKeys({
  isPdf,
  isEpub,
  presentation,
  bookMode,
  paging,
  contentRef,
}: UsePagingKeysInput) {
  const { pdfPageStep, pdfModeStep } = paging;
  useShortcut(isEpub ? null : "arrowright", () => pdfPageStep(1));
  useShortcut(isEpub ? null : "space", () => pdfPageStep(1));
  useShortcut(isEpub ? null : "arrowleft", () => pdfPageStep(-1));
  useShortcut(isEpub ? null : "pagedown", () => {
    // Outside the mode surfaces the scroll view scrolls a viewport-height
    // (issue #65); the shared decision above routes presenting and book mode
    // instead, because the page keys turn pages there, never scroll a
    // container the modes do not have.
    if (pdfModeStep(1)) return;
    scrollViewport(contentRef, 1);
  });
  useShortcut(isEpub ? null : "pageup", () => {
    if (pdfModeStep(-1)) return;
    scrollViewport(contentRef, -1);
  });
  // Shift+Space is the backward turn in book mode too (it used to be
  // registered only while presenting); the shared decision picks the surface.
  useShortcut(isPdf && (presentation || bookMode) ? "shift+space" : null, () => {
    pdfModeStep(-1);
  });
}
