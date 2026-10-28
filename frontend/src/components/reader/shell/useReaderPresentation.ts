import { useCallback, useEffect, useState, type RefObject } from "react";
import { useShortcut } from "@/lib/shortcuts";

interface UseReaderPresentationInput {
  bookId: number;
  bookOpen: boolean;
  readerViewRef: RefObject<HTMLDivElement | null>;
}

/**
 * Presentation mode (issues #65 PDF / #64 EPUB): Ctrl+L toggles, Esc exits,
 * and a native fullscreen exit (Esc while really fullscreen) ends the mode
 * through fullscreenchange. The fullscreen request is best-effort: a denied
 * request still gives the distraction-free layout, just inside the normal
 * window.
 */
export function useReaderPresentation({
  bookId,
  bookOpen,
  readerViewRef,
}: UseReaderPresentationInput) {
  const [presentation, setPresentation] = useState(false);
  // Whether the fullscreen request actually succeeded: Esc leaves real
  // fullscreen natively, and the fullscreenchange listener then ends the
  // mode, but a denied/unavailable request (jsdom, kiosk shells) must not
  // tear the mode down on the next event. State, not a ref: the book-switch
  // reset runs as a render-phase adjustment, where refs are off-limits.
  const [fullscreenEntered, setFullscreenEntered] = useState(false);

  // End presentation mode when the open book changes (also covers the
  // return-to-library path: the mode never outlives its book). Render-phase
  // adjustment keyed on the book, so the reset lands in the same render pass
  // as the switch.
  const [presentationBookId, setPresentationBookId] = useState(bookId);
  if (presentationBookId !== bookId) {
    setPresentationBookId(bookId);
    setPresentation(false);
    setFullscreenEntered(false);
  }

  const exitPresentation = useCallback(() => {
    setPresentation(false);
    if (fullscreenEntered && document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    }
    setFullscreenEntered(false);
  }, [fullscreenEntered]);

  const togglePresentation = useCallback(() => {
    if (presentation) {
      exitPresentation();
      return;
    }
    const surface = readerViewRef.current;
    const request = surface?.requestFullscreen?.bind(surface);
    if (request) {
      request()
        .then(() => {
          setFullscreenEntered(true);
        })
        .catch(() => {});
    }
    setPresentation(true);
  }, [exitPresentation, presentation, readerViewRef]);

  useShortcut(bookOpen ? "mod+l" : null, togglePresentation);
  useShortcut(presentation ? "escape" : null, exitPresentation);

  useEffect(() => {
    if (!presentation) return;
    const onFullscreenChange = () => {
      if (fullscreenEntered && !document.fullscreenElement) {
        setFullscreenEntered(false);
        setPresentation(false);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [presentation, fullscreenEntered]);

  return { presentation, exitPresentation, togglePresentation };
}
