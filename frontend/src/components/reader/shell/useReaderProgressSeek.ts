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
  const barRef = useRef<HTMLDivElement | null>(null);

  const readLabel = useCallback(
    (percent: number) => {
      const location = adapterRef.current?.progressionIndexFor?.(percent / 100) ?? null;
      setLabel(locationLabel(location, percent));
    },
    [adapterRef],
  );

  // The label is live while it shows: page turns move the value under a
  // resting pointer, and a label read only at pointer entry would sit frozen
  // at the location where the seek began.
  const barValue = preview ?? position;
  useEffect(() => {
    if (label === null) return;
    readLabel(barValue);
  }, [label, barValue, readLabel]);

  // A pointer seek is over: hand focus back to the reading surface.
  const releaseFocus = () => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && barRef.current?.contains(active)) {
      active.blur();
    }
  };

  return { preview, setPreview, label, setLabel, readLabel, barRef, releaseFocus };
}
