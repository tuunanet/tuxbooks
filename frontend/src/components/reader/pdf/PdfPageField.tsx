import { useEffect, useRef, useState } from "react";
import { parsePageNumber } from "./pdfPages";

interface PdfPageFieldProps {
  /** The live 1-based page number shown in the field. */
  pageNumber: number;
  /** Total pages; sizes the input and bounds the jump. */
  pageCount: number;
  /** Disabled until the reader layout is ready. */
  disabled?: boolean;
  /** Jump to a page through the reader's `goToPage` path. */
  onSetPage: (page: number) => void;
}

/**
 * Editable page number for the reader toolbar, mirroring the zoom percentage
 * field: focusing selects the current value, Enter (or a changed blur) commits
 * the jump, Escape discards, and an unparseable or out-of-range value is
 * clamped or ignored. The visible value is paired with a read-only `of {count}`
 * suffix; the accessible readout lives in the toolbar's hidden live region.
 */
export function PdfPageField({
  pageNumber,
  pageCount,
  disabled = false,
  onSetPage,
}: PdfPageFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const skipCommitRef = useRef(false);
  const editedRef = useRef(false);
  const display = draft ?? String(pageNumber);
  const digitCount = Math.max(1, String(pageCount).length);

  // A page change from outside the field (scroll, navigation, restore) while
  // the user has not typed must not leave a stale draft behind: drop it so
  // the field tracks the live page and a later blur cannot jump back.
  useEffect(() => {
    if (!editedRef.current) setDraft(null);
  }, [pageNumber]);

  const commit = () => {
    editedRef.current = false;
    if (skipCommitRef.current) {
      skipCommitRef.current = false;
      setDraft(null);
      return;
    }
    if (draft === null) return;
    const parsed = parsePageNumber(draft, pageCount);
    if (parsed !== null && parsed !== pageNumber) onSetPage(parsed);
    setDraft(null);
  };

  return (
    <div className="flex items-center gap-1">
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        data-testid="pdf-page-input"
        aria-label="Page number"
        disabled={disabled}
        value={display}
        style={{ width: `calc(${digitCount}ch + 1rem)` }}
        onFocus={(event) => {
          editedRef.current = false;
          setDraft(String(pageNumber));
          event.currentTarget.select();
        }}
        onChange={(event) => {
          editedRef.current = true;
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            // The blur below fires onBlur, whose commit closure still holds
            // the pre-commit draft; skip that second commit so Enter commits
            // exactly once.
            skipCommitRef.current = true;
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            event.preventDefault();
            editedRef.current = false;
            skipCommitRef.current = true;
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
        className="h-7 rounded-md border border-[var(--reader-chrome-border,var(--border))] bg-transparent px-2 text-right text-xs tabular-nums text-[var(--reader-chrome-muted,var(--foreground))] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50"
      />
      <span className="whitespace-nowrap text-xs text-[var(--reader-chrome-muted,var(--muted-foreground))] tabular-nums">
        of {pageCount}
      </span>
    </div>
  );
}
