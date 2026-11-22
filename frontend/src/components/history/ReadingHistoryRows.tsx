import { Link2, RotateCcw, Trash2 } from "lucide-react";
import { BookCover } from "@/components/books/BookCover";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { providerLinkLabel } from "@/lib/providers";
import type { BookTrashEntry, ReadingHistoryBook } from "@/lib/bridge";

function displayTitle(book: Pick<ReadingHistoryBook, "title">): string {
  const title = book.title?.trim();
  return title === undefined || title === "" ? "Unknown title" : title;
}

function displayAuthor(book: Pick<ReadingHistoryBook, "author">): string {
  const author = book.author?.trim();
  return author === undefined || author === "" ? "Unknown author" : author;
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(iso));
}

interface HistoryBookRowProps {
  book: ReadingHistoryBook;
  busy: boolean;
  selected: boolean;
  onToggle: (bookId: number, selected: boolean) => void;
  onRelink: (bookId: number) => void;
  onReset: (book: ReadingHistoryBook) => void;
  onForget: (book: ReadingHistoryBook) => void;
}

export function HistoryBookRow({
  book,
  busy,
  selected,
  onToggle,
  onRelink,
  onReset,
  onForget,
}: HistoryBookRowProps) {
  const progress =
    book.progressPercent === null ? "Not started" : `${Math.round(book.progressPercent)}% read`;
  const annotations = `${book.annotationCount} ${
    book.annotationCount === 1 ? "annotation" : "annotations"
  }`;

  return (
    <div
      data-testid="history-book"
      className="flex items-center gap-4 rounded-lg border bg-card p-3"
    >
      <Checkbox
        data-testid={`history-select-${book.id}`}
        aria-label={`Select ${displayTitle(book)}`}
        checked={selected}
        onCheckedChange={(checked) => onToggle(book.id, checked === true)}
      />
      <BookCover
        book={{ title: displayTitle(book), coverPath: book.coverPath }}
        className="h-20 w-14 shrink-0"
        initialClassName="text-lg"
      />
      <div className="min-w-0 flex-1">
        <h3 className="truncate font-medium">{displayTitle(book)}</h3>
        <p className="truncate text-sm text-muted-foreground">{displayAuthor(book)}</p>
        {book.isEmptyDuplicate ? (
          <p
            data-testid="history-duplicate-of"
            className="mt-1 truncate text-xs text-muted-foreground"
          >
            Empty duplicate
            {book.duplicateOfTitle ? (
              <>
                {" of "}
                <span className="font-medium">{book.duplicateOfTitle}</span>
              </>
            ) : null}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span data-testid="history-progress">{progress}</span>
          <span data-testid="history-annotations">{annotations}</span>
          {(book.providerLinks ?? []).map((link) => (
            <span key={`${link.provider}:${link.remoteId}`} data-testid="history-provider">
              {providerLinkLabel(link)}
            </span>
          ))}
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap justify-end gap-2">
        <Button
          data-testid={`history-reset-${book.id}`}
          aria-label={`Reset reading data for ${displayTitle(book)}`}
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onReset(book)}
        >
          <RotateCcw data-icon="inline-start" />
          Reset…
        </Button>
        <Button
          data-testid={`history-forget-${book.id}`}
          aria-label={`Forget ${displayTitle(book)}`}
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onForget(book)}
        >
          <Trash2 data-icon="inline-start" />
          Forget…
        </Button>
        <Button
          data-testid={`history-relink-${book.id}`}
          aria-label={`Relink ${displayTitle(book)}`}
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onRelink(book.id)}
        >
          <Link2 data-icon="inline-start" />
          {busy ? "Relinking…" : "Relink…"}
        </Button>
      </div>
    </div>
  );
}

interface ForgottenBookRowProps {
  entry: BookTrashEntry;
  busy: boolean;
  onRestore: (entry: BookTrashEntry) => void;
}

export function ForgottenBookRow({ entry, busy, onRestore }: ForgottenBookRowProps) {
  const progress =
    entry.progressPercent === null
      ? "No progress"
      : `${Math.round(entry.progressPercent)}% progress`;
  return (
    <li
      data-testid="book-trash-entry"
      className="flex items-center justify-between gap-4 rounded-lg border border-dashed p-3"
    >
      <div className="min-w-0">
        <h3 className="truncate font-medium">{displayTitle(entry)}</h3>
        <p className="truncate text-sm text-muted-foreground">{displayAuthor(entry)}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {progress} · {entry.annotationCount}{" "}
          {entry.annotationCount === 1 ? "annotation" : "annotations"} · forgotten{" "}
          {formatDate(entry.deletedAt)} · restorable until {formatDate(entry.expiresAt)}
        </p>
        {entry.hasNewState ? (
          <p data-testid="book-trash-new-state" className="mt-1 text-xs text-muted-foreground">
            The current book has new reading data; restoring asks what to do.
          </p>
        ) : null}
      </div>
      <Button
        data-testid={`book-trash-restore-${entry.id}`}
        aria-label={`Restore ${displayTitle(entry)}`}
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => onRestore(entry)}
      >
        <RotateCcw data-icon="inline-start" />
        Restore
      </Button>
    </li>
  );
}
