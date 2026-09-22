import { useCallback, useEffect, useRef, useState } from "react";
import { clampPage, parsePageNumber } from "./pdfPages";

/**
 * A wheel gesture whose accumulated normalized delta reaches this many pixels
 * steps one page. Smaller ticks accumulate so a trackpad glide still steps,
 * but the accumulator resets after a short idle so unrelated ticks minutes
 * apart never add up.
 */
const WHEEL_STEP_THRESHOLD = 24;
/** A line-mode wheel delta (deltaMode 1) roughly equals this many pixels. */
const WHEEL_LINE_HEIGHT = 16;
/** Idle time that ends a wheel gesture and clears its accumulator. */
const WHEEL_GESTURE_IDLE_MS = 200;

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
 *
 * The wheel and the Up/Down keys step one page while the field is focused.
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
  const inputRef = useRef<HTMLInputElement>(null);
  const wheelAccumRef = useRef(0);
  const wheelResetRef = useRef<number | null>(null);
  const display = draft ?? String(pageNumber);
  const digitCount = Math.max(1, String(pageCount).length);

  // The native wheel listener is attached once, so it reads the live props
  // through this ref rather than the closure it captured at mount.
  const stateRef = useRef({ pageNumber, pageCount, disabled, onSetPage });
  useEffect(() => {
    stateRef.current = { pageNumber, pageCount, disabled, onSetPage };
  });

  // A page change from outside the field (scroll, navigation, restore) while
  // the user has not typed must not leave a stale draft behind: drop it so
  // the field tracks the live page and a later blur cannot jump back.
  useEffect(() => {
    if (!editedRef.current) setDraft(null);
  }, [pageNumber]);

  const clearWheelReset = useCallback(() => {
    if (wheelResetRef.current !== null) {
      window.clearTimeout(wheelResetRef.current);
      wheelResetRef.current = null;
    }
  }, []);

  const stepBy = useCallback((delta: number) => {
    const live = stateRef.current;
    if (live.disabled) return;
    const next = clampPage(live.pageNumber + delta, live.pageCount);
    if (next === live.pageNumber) return;
    // Drop any in-progress edit so the field tracks the page we jump to and a
    // follow-up blur cannot commit the stale draft back.
    editedRef.current = false;
    setDraft(null);
    live.onSetPage(next);
  }, []);

  // React's onWheel is passive, so preventDefault there is a no-op; attach
  // natively to keep the modified-wheel gesture available to page zoom.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (stateRef.current.disabled) return;
      if (document.activeElement !== input) return;
      const normalized = event.deltaY * (event.deltaMode === 1 ? WHEEL_LINE_HEIGHT : 1);
      const accumulated = wheelAccumRef.current + normalized;
      clearWheelReset();
      wheelResetRef.current = window.setTimeout(() => {
        wheelAccumRef.current = 0;
        wheelResetRef.current = null;
      }, WHEEL_GESTURE_IDLE_MS);
      if (Math.abs(accumulated) < WHEEL_STEP_THRESHOLD) {
        wheelAccumRef.current = accumulated;
        return;
      }
      event.preventDefault();
      wheelAccumRef.current = 0;
      stepBy(accumulated > 0 ? 1 : -1);
    };
    input.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      input.removeEventListener("wheel", onWheel);
      clearWheelReset();
    };
  }, [stepBy, clearWheelReset]);

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
        ref={inputRef}
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
        onBlur={() => {
          clearWheelReset();
          wheelAccumRef.current = 0;
          commit();
        }}
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
          } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            stepBy(event.key === "ArrowDown" ? 1 : -1);
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
