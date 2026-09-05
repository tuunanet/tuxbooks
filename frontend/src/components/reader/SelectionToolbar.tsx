import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HIGHLIGHT_COLORS, type HighlightColor } from "./annotationModel";

const COLOR_ORDER: HighlightColor[] = ["yellow", "green", "blue", "red", "purple"];

interface SelectionToolbarProps {
  /** The live selection's text; null when nothing is selected. */
  selection: { text: string } | null;
  /** Creates a persistent highlight in the chosen color. */
  onCreate: (color: HighlightColor) => void;
  /** Dismisses the selection without creating anything. */
  onDismiss: () => void;
}

/**
 * Floating actions for a text selection in the reading surface: one swatch
 * per highlight color. The active reader owns the selection itself; this
 * bar only offers the choice of color and reports it back.
 */
export function SelectionToolbar({ selection, onCreate, onDismiss }: SelectionToolbarProps) {
  if (!selection) return null;
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
      {COLOR_ORDER.map((color) => (
        <button
          key={color}
          type="button"
          data-testid={`highlight-color-${color}`}
          aria-label={`Highlight in ${color}`}
          title={`Highlight in ${color}`}
          onClick={() => onCreate(color)}
          className="size-5 shrink-0 rounded-full border border-black/20 outline-none hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/50"
          style={{ background: HIGHLIGHT_COLORS[color] }}
        />
      ))}
      <Button variant="ghost" size="icon-sm" aria-label="Dismiss selection" onClick={onDismiss}>
        <X />
      </Button>
    </div>
  );
}
