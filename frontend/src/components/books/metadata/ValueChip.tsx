import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * A chip for a value the book file or the user supplies, such as a subject or
 * an author. It wraps inside its row instead of widening it. Words break with
 * `overflow-wrap: anywhere` and not `break-words`, because only `anywhere`
 * also shrinks the chip's min-content. A value longer than the form then
 * wraps instead of widening the grid column it sits in.
 *
 * `py-0` with `min-h-5` keeps a one-line chip at the Badge's 20px. A wrapped
 * chip grows by 16px a line.
 */
export function ValueChip({ className, ...props }: React.ComponentProps<typeof Badge>) {
  return (
    <Badge
      variant="secondary"
      {...props}
      className={cn("h-auto min-h-5 max-w-full py-0 whitespace-normal wrap-anywhere", className)}
    />
  );
}
