import { useEffect } from "react";
import type { Dispatch } from "react";
import type { AppAction } from "@/state/appState";
import type { Annotation } from "@/types/domain";
import { jumpToAnnotation as annotationJumpTarget, type ReaderJump } from "../readerModel";

interface UseInitialJumpInput {
  targetId: number | null | undefined;
  annotations: Annotation[];
  loaded: boolean;
  dispatch: Dispatch<AppAction>;
}

/**
 * A highlight opened from the book detail view becomes the reader's initial
 * destination: the readers apply it as part of their restore, so the initial
 * scroll sample cannot read it back as the saved page. The target is
 * single-use, so the shell drops it once the annotation list resolved.
 */
export function useInitialJump({ targetId, annotations, loaded, dispatch }: UseInitialJumpInput) {
  const target =
    targetId == null
      ? null
      : (annotations.find((annotation) => annotation.id === targetId) ?? null);
  const initialJump: ReaderJump | null = target === null ? null : annotationJumpTarget(target);
  const waiting = targetId != null && !loaded;

  useEffect(() => {
    if (targetId != null && loaded) dispatch({ type: "reader-target-consumed" });
  }, [targetId, loaded, dispatch]);

  return { initialJump, waiting };
}
