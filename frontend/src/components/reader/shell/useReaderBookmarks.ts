import { useCallback, useRef, useState } from "react";
import { useShortcut } from "@/lib/shortcuts";
import type { useAnnotations } from "@/hooks/useAnnotations";
import { bookmarkLocationAndProgress } from "@/lib/annotationLocation";
import type { EpubTocItem } from "@/lib/epub/readiumEngine";
import type { Annotation } from "@/types/domain";
import {
  bookmarkBaseLabel,
  bookmarkInputFor,
  isBookmarkAtPosition,
  type ReaderPosition,
} from "../readerModel";

interface UseReaderBookmarksInput {
  activePosition: ReaderPosition | null;
  annotationsApi: ReturnType<typeof useAnnotations>;
  epubToc: EpubTocItem[] | null;
  isEpub: boolean | undefined;
}

/**
 * Bookmarks: toggle at the exact current position (EPUB CFI / PDF page), so
 * the button also removes a bookmark placed on the same spot. Creating one
 * opens the label popover, which always binds to the newest bookmark; the
 * busy flag swallows presses while a create/remove round-trips, so a
 * double-press cannot make two bookmarks.
 */
export function useReaderBookmarks({
  activePosition,
  annotationsApi,
  epubToc,
  isEpub,
}: UseReaderBookmarksInput) {
  const { annotations, create, remove, update } = annotationsApi;
  const [labelTarget, setLabelTarget] = useState<{
    bookmark: Annotation;
    hint: string;
  } | null>(null);
  const bookmarkBusyRef = useRef(false);

  const toggleBookmark = useCallback(async () => {
    if (!activePosition || bookmarkBusyRef.current) return;
    bookmarkBusyRef.current = true;
    const existing = annotations.find((annotation) =>
      isBookmarkAtPosition(annotation, activePosition),
    );
    try {
      if (existing) {
        // Removing closes the popover; its half-typed draft goes with the
        // bookmark it belonged to.
        setLabelTarget(null);
        await remove(existing.id);
        return;
      }
      const created = await create(bookmarkInputFor(activePosition));
      // A failed create stays silent (console-only), and no popover opens.
      if (!created) return;
      // The popover's hint names what is being labeled: the chapter/page,
      // the in-chapter progress when the locator carries it, and the save.
      const baseLabel = bookmarkBaseLabel(created, isEpub ? epubToc : null);
      setLabelTarget({
        bookmark: created,
        hint: `${bookmarkLocationAndProgress(created, baseLabel)} · Saved just now`,
      });
    } finally {
      bookmarkBusyRef.current = false;
    }
  }, [activePosition, annotations, create, epubToc, isEpub, remove]);
  useShortcut("mod+b", toggleBookmark);

  const closeLabelPopover = useCallback(() => setLabelTarget(null), []);
  const commitBookmarkLabel = useCallback(
    (bookmarkId: number, label: string) => {
      void update(bookmarkId, { label });
    },
    [update],
  );

  const bookmarked =
    activePosition !== null &&
    annotations.some((annotation) => isBookmarkAtPosition(annotation, activePosition));

  return {
    labelTarget,
    bookmarked,
    toggleBookmark,
    closeLabelPopover,
    commitBookmarkLabel,
  };
}
