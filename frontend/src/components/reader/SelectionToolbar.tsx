import { Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HIGHLIGHT_COLOR_KEYS, type HighlightColor } from "@/lib/highlightPalette";
import type { HighlightAction, ReaderSelection } from "./annotationModel";

interface SelectionToolbarProps {
  /** The live selection or clicked highlight; null when nothing is active. */
  selection: ReaderSelection | null;
  /**
   * Applies a highlight action: a color choice creates from a fresh
   * selection or recolors the targeted highlight, `remove` deletes the
   * targeted highlight annotation.
   */
  onAction: (action: HighlightAction) => void;
  /** Dismisses the selection without changing anything. */
  onDismiss: () => void;
  /** Resolves a persisted palette slot to the active theme family's wash. */
  colorFor: (color: HighlightColor) => string;
}

/**
 * Floating actions for a text selection in the reading surface: one swatch
 * per highlight color, plus — when the selection or click targets an
 * existing highlight — a distinct Remove action that deletes the
 * annotation. The active reader owns the selection itself; this bar only
 * reports the chosen action back.
 */
export function SelectionToolbar({
  selection,
  onAction,
  onDismiss,
  colorFor,
}: SelectionToolbarProps) {
  if (!selection) return null;
  const editing = selection.highlightId !== null;
  return (
    <div
      data-testid="selection-toolbar"
      role="toolbar"
      aria-label="Highlight selection"
      className="fixed inset-x-0 bottom-14 z-40 mx-auto flex w-fit items-center gap-2 rounded-lg border bg-popover p-2 pl-3 text-popover-foreground shadow-lg"
    >
      <span
        data-testid="selection-text"
        className="max-w-56 truncate text-xs text-muted-foreground"
      >
        {selection.text}
      </span>
      {HIGHLIGHT_COLOR_KEYS.map((color) => (
        <button
          key={color}
          type="button"
          data-testid={`highlight-color-${color}`}
          aria-label={editing ? `Change highlight to ${color}` : `Highlight in ${color}`}
          title={editing ? `Change highlight to ${color}` : `Highlight in ${color}`}
          onClick={() => onAction({ type: "setColor", color })}
          className="size-5 shrink-0 rounded-full border border-black/20 outline-none hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/50"
          style={{ background: colorFor(color) }}
        />
      ))}
      {editing && (
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="highlight-remove"
          aria-label="Remove highlight"
          title="Remove highlight"
          className="text-destructive hover:text-destructive"
          onClick={() => onAction({ type: "remove" })}
        >
          <Trash2 />
        </Button>
      )}
      <Button variant="ghost" size="icon-sm" aria-label="Dismiss selection" onClick={onDismiss}>
        <X />
      </Button>
    </div>
  );
}
