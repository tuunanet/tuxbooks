import { useState } from "react";
import { cn } from "@/lib/utils";
import { coverFileUrl } from "@/lib/tauri";
import type { Book } from "@/types/domain";

interface BookCoverProps {
  book: Book;
  className?: string;
  initialClassName?: string;
}

/**
 * Cover art: the real extracted cover through the Tauri asset protocol
 * (decision D2) when the book has one, otherwise gradient placeholder art.
 * A failed load (e.g. missing file, plain Vite preview) falls back to the
 * placeholder instead of showing a broken image.
 */
export function BookCover({ book, className, initialClassName }: BookCoverProps) {
  const [loadFailed, setLoadFailed] = useState(false);
  const coverPath = book.coverPath;
  const showImage = coverPath !== null && !loadFailed;

  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-primary/25 via-accent to-muted ring-1 ring-foreground/10",
        className,
      )}
    >
      {showImage && coverPath !== null ? (
        <img
          src={coverFileUrl(coverPath)}
          alt=""
          onError={() => setLoadFailed(true)}
          className="size-full object-cover"
          draggable={false}
        />
      ) : (
        <span className={cn("font-semibold text-primary/50 select-none", initialClassName)}>
          {book.title.charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );
}
