import { Label } from "@/components/ui/label";

/** Label with a marker when the stored value differs from the source file. */
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
          title="This value differs from the source file"
          aria-label="differs from the source file"
          className="size-1.5 rounded-full bg-amber-500"
        />
      )}
    </Label>
  );
}
