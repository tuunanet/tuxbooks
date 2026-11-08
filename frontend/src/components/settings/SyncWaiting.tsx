import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { WaitingBook } from "@/lib/bridge";
import { ViewAllDialog } from "./SyncListDialog";

const SUMMARY_LIMIT = 5;

function WaitingBookRow({
  book,
  busy,
  onLocate,
  onForget,
}: {
  book: WaitingBook;
  busy: boolean;
  onLocate: (bookUid: string) => void;
  onForget: (bookUid: string) => void;
}) {
  return (
    <li
      data-testid={`waiting-book-${book.bookUid}`}
      className="flex flex-wrap items-start justify-between gap-3 border-t pt-3 first:border-t-0 first:pt-0"
    >
      <div className="min-w-0">
        <p className="truncate font-medium">{book.title ?? "Unknown book"}</p>
        {book.author ? (
          <p className="truncate text-xs text-muted-foreground">{book.author}</p>
        ) : null}
        <p className="mt-1 text-xs text-muted-foreground">
          {book.progressPercent === null ? "No progress" : `${Math.round(book.progressPercent)}%`}
          {" · "}
          {book.annotationCount} {book.annotationCount === 1 ? "annotation" : "annotations"}
        </p>
        {book.sampleAnnotation ? (
          <p className="mt-1 text-xs text-muted-foreground">Sample: {book.sampleAnnotation}</p>
        ) : null}
        <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{book.bookUid}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          data-testid={`locate-waiting-${book.bookUid}`}
          onClick={() => onLocate(book.bookUid)}
          disabled={busy}
        >
          Locate file
        </Button>
        <Button
          size="sm"
          variant="outline"
          data-testid={`forget-waiting-${book.bookUid}`}
          onClick={() => onForget(book.bookUid)}
          disabled={busy}
        >
          Forget on this device
        </Button>
      </div>
    </li>
  );
}

export function WaitingBooksSection({
  books,
  total,
  busy,
  onLocate,
  onForget,
  onForgetAll,
}: {
  books: WaitingBook[];
  total: number;
  busy: boolean;
  onLocate: (bookUid: string) => void;
  onForget: (bookUid: string) => void;
  onForgetAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmForgetAll, setConfirmForgetAll] = useState(false);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return books;
    return books.filter((book) =>
      [book.title, book.author, book.sampleAnnotation, book.bookUid].some((value) =>
        value?.toLowerCase().includes(needle),
      ),
    );
  }, [books, query]);
  const summary = filtered.slice(0, SUMMARY_LIMIT);
  const truncated = total > books.length;

  return (
    <section data-testid="waiting-books" className="rounded-lg border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-medium">Waiting for books</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Shared reading state for books whose file is not in this library. Locate file attaches
            the book when you pick the exact bytes. Forget on this device hides it here; the synced
            copy stays in the folder and on other devices.
          </p>
        </div>
        {total > 0 ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="waiting-books-forget-all"
            onClick={() => setConfirmForgetAll(true)}
            disabled={busy}
          >
            Forget all on this device
          </Button>
        ) : null}
      </div>

      {total === 0 ? (
        <p data-testid="waiting-books-empty" className="mt-3 text-sm text-muted-foreground">
          No books are waiting for a file.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input
              data-testid="waiting-books-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title or book uid"
              className="h-9 max-w-sm"
            />
            {filtered.length > SUMMARY_LIMIT ? (
              <Button
                size="sm"
                variant="ghost"
                data-testid="waiting-books-view-all"
                onClick={() => setOpen(true)}
              >
                View all {filtered.length}
              </Button>
            ) : null}
            {truncated ? (
              <p className="text-xs text-muted-foreground">
                Showing first {books.length} of {total}.
              </p>
            ) : null}
          </div>
          <ul className="mt-3 flex flex-col gap-3">
            {summary.map((book) => (
              <WaitingBookRow
                key={book.bookUid}
                book={book}
                busy={busy}
                onLocate={onLocate}
                onForget={onForget}
              />
            ))}
          </ul>
          {filtered.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No waiting books match.</p>
          ) : null}
        </>
      )}

      <ViewAllDialog
        open={open}
        onOpenChange={setOpen}
        title="Waiting for books"
        description="Shared state for books whose file is not in this library. The synced copy is not deleted."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button
              variant="outline"
              data-testid="waiting-books-forget-all-dialog"
              onClick={() => {
                setOpen(false);
                setConfirmForgetAll(true);
              }}
              disabled={busy}
            >
              Forget all on this device
            </Button>
          </>
        }
      >
        <ul className="flex flex-col gap-3">
          {filtered.map((book) => (
            <WaitingBookRow
              key={book.bookUid}
              book={book}
              busy={busy}
              onLocate={onLocate}
              onForget={onForget}
            />
          ))}
        </ul>
      </ViewAllDialog>

      <Dialog open={confirmForgetAll} onOpenChange={setConfirmForgetAll}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Forget all waiting books on this device?</DialogTitle>
            <DialogDescription>
              This hides all {total} waiting {total === 1 ? "book" : "books"} here and drops the
              count. The synced copies stay in the folder, so importing the exact bytes can still
              attach them later. Other devices are not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmForgetAll(false)}>
              Cancel
            </Button>
            <Button
              data-testid="waiting-books-forget-all-confirm"
              onClick={() => {
                setConfirmForgetAll(false);
                onForgetAll();
              }}
              disabled={busy}
            >
              Forget all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
