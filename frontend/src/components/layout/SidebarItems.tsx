import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Icon plus truncated text, the standard row content. */
export function ItemLabel({
  icon: Icon,
  children,
  testId,
}: {
  icon: LucideIcon;
  children: string;
  testId?: string;
}) {
  return (
    <span data-testid={testId} className="flex min-w-0 items-center gap-2.5">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate">{children}</span>
    </span>
  );
}

export function GroupLabel({ children }: { children: string }) {
  return (
    <p className="mb-1 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

interface ItemButtonProps {
  active: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
  disabled?: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  testId?: string;
  ariaHaspopup?: "dialog";
  wrapperProps?: React.HTMLAttributes<HTMLDivElement> &
    Record<`data-${string}`, string | number | undefined>;
}

export function ItemButton({
  active,
  onClick,
  children,
  disabled,
  leading,
  trailing,
  testId,
  ariaHaspopup,
  wrapperProps,
}: ItemButtonProps) {
  const { className: wrapperClassName, ...wrapperRest } = wrapperProps ?? {};
  return (
    <div
      className={cn("group/item relative data-[dragging=true]:opacity-60", wrapperClassName)}
      {...wrapperRest}
    >
      {leading}
      <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        disabled={disabled}
        aria-current={active ? "true" : undefined}
        aria-haspopup={ariaHaspopup}
        className={cn(
          "flex w-full items-center rounded-md px-3 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50",
          leading && "pl-7",
          trailing && "pr-16",
          active
            ? "bg-accent font-medium text-accent-foreground"
            : "text-foreground hover:bg-accent/60",
          disabled && "cursor-not-allowed opacity-50",
        )}
      >
        {children}
      </button>
      {trailing}
    </div>
  );
}
