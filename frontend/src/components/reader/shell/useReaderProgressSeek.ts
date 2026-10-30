import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { locationLabel, type ReaderAdapter } from "../readerModel";

interface UseReaderProgressSeekInput {
  position: number;
  adapterRef: RefObject<ReaderAdapter | null>;
}

/**
 * Progress-bar state: the drag preview (presentation only, never the stored
 * position), the live positioning label, and the focus hand-back after a
 * pointer seek. Only the release commits a navigation, one jump per gesture.
 */
export function useReaderProgressSeek({ position, adapterRef }: UseReaderProgressSeekInput) {
  const [preview, setPreview] = useState<number | null>(null);
  // While you hover or drag the bar it shows the Kindle-style positioning
  // label ("Location N of M • P%"); leaving the bar clears it. The adapter
  // query runs inside the pointer handlers, so refs stay out of render, and
  // a null open adapter degrades the label to percent-only.
  const [label, setLabel] = useState<string | null>(null);
  // Whether the positioning label is showing. A ref rather than the label
  // state: a relocate re-render can queue its refresh effect before
  // pointerleave clears the label, and that effect must not read the stale
  // non-null label and put the tooltip back.
  const labelOpenRef = useRef(false);
  const barRef = useRef<HTMLDivElement | null>(null);

  const labelFor = useCallback(
    (percent: number) => {
      const location = adapterRef.current?.progressionIndexFor?.(percent / 100) ?? null;
      return locationLabel(location, percent);
    },
    [adapterRef],
  );

  const readLabel = useCallback(
    (percent: number) => {
      labelOpenRef.current = true;
      setLabel(labelFor(percent));
    },
    [labelFor],
  );

  const clearLabel = useCallback(() => {
    labelOpenRef.current = false;
    setLabel(null);
  }, []);

  // The label is live while it shows: page turns move the value under a
  // resting pointer, and a label read only at pointer entry would sit frozen
  // at the location where the seek began.
  const barValue = preview ?? position;
  useEffect(() => {
    if (!labelOpenRef.current) return;
    setLabel(labelFor(barValue));
  }, [barValue, labelFor]);

  // A pointer seek is over: hand focus back to the reading surface.
  const releaseFocus = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && barRef.current?.contains(active)) {
      active.blur();
    }
  };

  return {
    preview,
    setPreview,
    label,
    readLabel,
    clearLabel,
    barRef,
    releaseFocus,
  };
}
