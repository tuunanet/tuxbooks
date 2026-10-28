import { useCallback, useMemo, useState, type RefObject } from "react";
import type { useAnnotations } from "@/hooks/useAnnotations";
import type { AnnotationInput } from "@/types/domain";
import { byKind, type HighlightAction, type ReaderSelection } from "../annotationModel";
import type { ReaderAdapter } from "../readerModel";

interface UseReaderHighlightsInput {
  bookId: number;
  annotationsApi: ReturnType<typeof useAnnotations>;
  adapterRef: RefObject<ReaderAdapter | null>;
}

/**
 * Selection toolbar state and annotation edits. The selection is tagged with
 * the book whose reader reported it (readers remount per book, so a stale
 * book can never write here). The report carries the existing highlight the
 * selection or click targets, which flips the toolbar from creating to
 * editing.
 */
export function useReaderHighlights({
  bookId,
  annotationsApi,
  adapterRef,
}: UseReaderHighlightsInput) {
  const { annotations, create, remove, update } = annotationsApi;
  const [selection, setSelection] = useState<(ReaderSelection & { bookId: number }) | null>(null);

  const activeSelection = useMemo(
    () =>
      selection !== null && selection.bookId === bookId
        ? { text: selection.text, highlightId: selection.highlightId }
        : null,
    [selection, bookId],
  );

  const handleCreateHighlight = useCallback(
    (input: AnnotationInput) => {
      void create(input);
    },
    [create],
  );
  const handleSelectionFrom = useCallback((id: number, reported: ReaderSelection | null) => {
    setSelection(reported === null ? null : { bookId: id, ...reported });
  }, []);

  // An existing highlight is edited in place: a color choice recolors the
  // annotation, Remove deletes it outright, never a transparent recolor,
  // which would leave a dead annotation behind.
  const applyHighlightAction = useCallback(
    (annotationId: number, action: HighlightAction) => {
      if (action.type === "remove") void remove(annotationId);
      else void update(annotationId, { color: action.color });
    },
    [remove, update],
  );
  const handleHighlightAction = useCallback(
    (action: HighlightAction) => {
      const target = activeSelection;
      if (target === null) return;
      if (target.highlightId !== null) {
        applyHighlightAction(target.highlightId, action);
        adapterRef.current?.annotations.clearSelection();
        return;
      }
      if (action.type === "setColor") {
        adapterRef.current?.annotations.createHighlight(action.color);
      }
    },
    [activeSelection, adapterRef, applyHighlightAction],
  );
  const handleDismissSelection = useCallback(() => {
    adapterRef.current?.annotations.clearSelection();
  }, [adapterRef]);

  const highlights = useMemo(() => byKind(annotations, "highlight"), [annotations]);

  return {
    activeSelection,
    highlights,
    handleCreateHighlight,
    handleSelectionFrom,
    handleHighlightAction,
    handleDismissSelection,
  };
}
