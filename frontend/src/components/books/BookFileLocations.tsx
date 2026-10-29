import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Book, BookFile } from "@/lib/bridge";
import { formatMb } from "@/lib/format";

/** Exact-enough sizes; a small EPUB must not read as "0.0 MB". */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return formatMb(bytes);
}

/**
 * Before the locations query resolves, the active file from `list_books` is
 * the one fact the details already know. The fallback keeps the path visible
 * without pretending a second copy exists.
 */
function locationsFor(book: Book, files: BookFile[]): BookFile[] {
  if (files.length > 0) return files;
  return [
    {
      id: -1,
      path: book.path,
      available: book.available,
      fileSize: book.fileSize,
      fileMtime: book.fileMtime,
      addedAt: book.addedAt,
      active: true,
    },
  ];
}

interface BookFileLocationsProps {
  book: Book;
  files: BookFile[];
  onRemove: (fileId: number) => void;
}

/**
 * Every location of a durable book (ADR 0014 D7). Duplicate copies share one
 * library entry and its reading state; each row can remove its own membership
 * without touching the file on disk or the book.
 */
export function BookFileLocations({ book, files, onRemove }: BookFileLocationsProps) {
  const locations = locationsFor(book, files);
  const canRemove = locations.length > 1;

  return (
    <div className="mt-8">
      <h3 className="text-sm font-medium text-muted-foreground">File locations</h3>
      <ul data-testid="detail-file-locations" className="mt-2 divide-y rounded-lg border text-sm">
        {locations.map((file) => (
          <li
            key={file.id}
            data-testid={`detail-file-${file.id}`}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
          >
            <div className="min-w-0 flex-1">
              <code className="block break-all text-xs text-muted-foreground">{file.path}</code>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {file.active && (
                  <Badge
                    variant="secondary"
                    data-testid={`detail-file-active-${file.id}`}
                    className="text-[10px]"
                  >
                    Reading from
                  </Badge>
                )}
                {file.available ? (
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {formatFileSize(file.fileSize)}
                  </span>
                ) : (
                  <Badge variant="destructive" className="text-[10px]">
                    Missing
                  </Badge>
                )}
              </div>
            </div>
            {canRemove && file.id > 0 && (
              <Button
                variant="outline"
                size="sm"
                data-testid={`detail-file-remove-${file.id}`}
                onClick={() => onRemove(file.id)}
              >
                Remove copy
              </Button>
            )}
          </li>
        ))}
      </ul>
      {canRemove && (
        <p className="mt-2 text-xs text-muted-foreground">
          These copies share progress, annotations, and collections. Removing one keeps the book and
          your reading data; the file on disk is never touched.
        </p>
      )}
    </div>
  );
}
