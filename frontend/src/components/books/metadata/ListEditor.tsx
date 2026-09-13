import { useState } from "react";
import { Plus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export interface ListEditorProps {
  id: string;
  testId: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  addLabel: string;
  disabled?: boolean;
}

/** Chip editor for multi-value metadata (authors, subjects). */
export function ListEditor({
  id,
  testId,
  values,
  onChange,
  placeholder,
  addLabel,
  disabled = false,
}: ListEditorProps) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const value = draft.trim();
    if (value === "") return;
    if (!values.includes(value)) onChange([...values, value]);
    setDraft("");
  };

  return (
    <div className="grid gap-2">
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5" data-testid={`${testId}-list`}>
          {values.map((value) => (
            <Badge key={value} variant="secondary" className="gap-1 pr-1">
              {value}
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${value}`}
                  data-testid={`${testId}-remove-${value}`}
                  className="rounded-full p-0.5 hover:bg-foreground/10"
                  onClick={() => onChange(values.filter((entry) => entry !== value))}
                >
                  <X className="size-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Input
          id={id}
          data-testid={testId}
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={add}
          data-testid={`${testId}-add`}
        >
          <Plus data-icon="inline-start" />
          {addLabel}
        </Button>
      </div>
    </div>
  );
}
