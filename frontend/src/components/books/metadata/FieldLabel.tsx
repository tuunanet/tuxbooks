import { Label } from "@/components/ui/label";

/** Label with a marker when the field's value is a library edit, so the
 * book file keeps a different value. */
export function FieldLabel({
  htmlFor,
  children,
  overridden,
}: {
  htmlFor: string;
  children: string;
  overridden?: boolean;
}) {
  return (
    <Label htmlFor={htmlFor} className="flex items-center gap-1.5 text-sm font-medium">
      {children}
      {overridden && (
        <span
          data-testid={`${htmlFor}-overridden`}
          title="Library edit: the book file keeps a different value"
          aria-label="library edit"
          className="size-1.5 rounded-full bg-amber-500"
        />
      )}
    </Label>
  );
}
