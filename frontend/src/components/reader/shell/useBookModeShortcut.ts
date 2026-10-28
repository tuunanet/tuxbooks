import { useShortcut } from "@/lib/shortcuts";
import { READER_BOOK_MODE_SHORTCUT } from "@/lib/readerShortcuts";

interface UseBookModeShortcutInput {
  bookOpen: boolean;
  presentation: boolean;
  toggleBookMode: () => void;
}

/** The book-mode key, registered only when it would be visible. */
export function useBookModeShortcut({
  bookOpen,
  presentation,
  toggleBookMode,
}: UseBookModeShortcutInput) {
  // Not registered while presenting: an invisible flip would surprise the
  // reader on exit.
  useShortcut(bookOpen && !presentation ? READER_BOOK_MODE_SHORTCUT : null, toggleBookMode);
}
