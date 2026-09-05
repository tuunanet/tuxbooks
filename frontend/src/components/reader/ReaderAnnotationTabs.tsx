import { useState } from "react";
import { NotebookPen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import type { AnnotationPatch } from "@/types/domain";
import type { Annotation } from "@/types/domain";
import { highlightCssColor, HIGHLIGHT_COLORS, type HighlightColor } from "./annotationModel";

const COLOR_ORDER: HighlightColor[] = ["yellow", "green", "blue", "red", "purple"];

interface ReaderAnnotationListProps {
  annotations: Annotation[];
  /** Shows the color dot and the color swatches (highlights). */
  withColor: boolean;
  /** One-line title of a row ("Page 3", a chapter label, …). */
  label: (annotation: Annotation) => string;
  /** Navigates the reader to the annotation's position. */
  onJump: (annotation: Annotation) => void;
  onDelete: (id: number) => void;
  onUpdate: (id: number, patch: AnnotationPatch) => void;
  /** Prefix for row test ids: `${prefix}-${index}`. */
  testIdPrefix: string;
}

/**
 * Rows of persistent annotations (bookmarks or highlights) with per-row
 * note editing, optional recoloring, deletion, and jump-to-position.
 * Shared by the navigation drawer's Bookmarks and Highlights tabs.
 */
export function ReaderAnnotationList({
  annotations,
  withColor,
  label,
  onJump,
  onDelete,
  onUpdate,
  testIdPrefix,
}: ReaderAnnotationListProps) {
  const [editing, setEditing] = useState<{ id: number; draft: string } | null>(null);

  const saveNote = () => {
    if (!editing) return;
    onUpdate(editing.id, { note: editing.draft });
    setEditing(null);
  };

  return (
    <ScrollArea className="h-full px-2 pr-2">
      {annotations.map((annotation, index) => (
        <div
          key={annotation.id}
          data-testid={`${testIdPrefix}-${index}`}
          className="rounded-md px-1 py-1.5 hover:bg-accent/60"
        >
          <div className="flex items-center gap-1.5">
            {withColor && (
              <span
                aria-hidden
                className="size-2.5 shrink-0 rounded-full border border-black/20"
                data-testid={`${testIdPrefix}-color-${index}`}
                style={{ background: highlightCssColor(annotation.color) }}
              />
            )}
            <button
              type="button"
              data-testid={`${testIdPrefix}-jump-${index}`}
              onClick={() => onJump(annotation)}
              className="min-w-0 flex-1 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span className="block truncate text-sm">{label(annotation)}</span>
              {annotation.text && (
                <span className="block truncate text-xs text-muted-foreground">
                  {annotation.text}
                </span>
              )}
              {annotation.note && (
                <span className="block truncate text-xs italic text-muted-foreground">
                  {annotation.note}
                </span>
              )}
            </button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              data-testid={`${testIdPrefix}-note-${index}`}
              aria-label={annotation.note ? "Edit note" : "Add note"}
              onClick={() =>
                setEditing((current) =>
                  current?.id === annotation.id
                    ? null
                    : { id: annotation.id, draft: annotation.note ?? "" },
                )
              }
            >
              <NotebookPen />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              data-testid={`${testIdPrefix}-delete-${index}`}
              aria-label="Delete annotation"
              onClick={() => {
                if (editing?.id === annotation.id) setEditing(null);
                onDelete(annotation.id);
              }}
            >
              <Trash2 />
            </Button>
          </div>
          {editing?.id === annotation.id && (
            <div className="mt-1 space-y-2 pb-1 pl-1">
              {withColor && (
                <div
                  className="flex items-center gap-1.5"
                  data-testid={`${testIdPrefix}-swatches-${index}`}
                >
                  {COLOR_ORDER.map((color) => (
                    <button
                      key={color}
                      type="button"
                      aria-label={`Change highlight color to ${color}`}
                      title={`Change highlight color to ${color}`}
                      onClick={() => onUpdate(annotation.id, { color })}
                      className="size-4 rounded-full border border-black/20 outline-none hover:scale-110 focus-visible:ring-3 focus-visible:ring-ring/50"
                      style={{ background: HIGHLIGHT_COLORS[color] }}
                    />
                  ))}
                </div>
              )}
              <textarea
                data-testid="annotation-note-input"
                aria-label="Note"
                rows={3}
                value={editing.draft}
                onChange={(event) => setEditing({ id: annotation.id, draft: event.target.value })}
                className="w-full rounded-md border bg-transparent p-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              />
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="annotation-note-cancel"
                  onClick={() => setEditing(null)}
                >
                  Cancel
                </Button>
                <Button size="sm" data-testid="annotation-note-save" onClick={saveNote}>
                  Save note
                </Button>
              </div>
            </div>
          )}
        </div>
      ))}
      <ScrollBar />
    </ScrollArea>
  );
}
