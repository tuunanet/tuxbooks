import { Fragment } from "react";
import { ArrowLeft, BookOpen, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BookCover } from "./BookCover";
import { useLibrary } from "@/hooks/useLibrary";
import { sectionTitle } from "@/components/library/sections";
import { useAppDispatch, useAppState } from "@/state/appState";

/** ISO dates render deterministically in UTC so tests and locales agree. */
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(iso));
}

/**
 * Book detail view, rendered inside the library shell (sidebar stays).
 * Data comes from the shared `list_books` payload — there is no
 * `get_book` command yet (decision D1). Reading progress is not shown:
 * no backend command exposes it, and progress without data would be a
 * pretend-success.
 */
export function BookDetail() {
  const { selectedBookId, section } = useAppState();
  const { books } = useLibrary();
  const dispatch = useAppDispatch();

  const book = books.find((candidate) => candidate.id === selectedBookId) ?? null;

  if (!book) {
    return (
      <section data-testid="book-detail-missing" className="pt-16 text-center">
        <h2 className="text-xl font-semibold">This book is no longer in the library</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          It may have been re-imported with a different id, or removed on disk.
        </p>
        <Button
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => dispatch({ type: "return-to-library" })}
        >
          <ArrowLeft data-icon="inline-start" />
          Back to {sectionTitle(section)}
        </Button>
      </section>
    );
  }

  const facts: [string, string][] = [
    ["Format", book.format.toUpperCase()],
    ["Publisher", book.publisher ?? "—"],
    ["Language", book.language ?? "—"],
    ["ISBN", book.isbn ?? "—"],
    ["Added", formatDate(book.addedAt)],
    ["Last opened", formatDate(book.lastOpenedAt)],
    ["File", book.path],
  ];

  return (
    <section data-testid="book-detail" className="mx-auto max-w-3xl">
      <Button
        variant="ghost"
        size="sm"
        data-testid="detail-back"
        className="-ml-2"
        onClick={() => dispatch({ type: "return-to-library" })}
      >
        <ArrowLeft data-icon="inline-start" />
        Back to {sectionTitle(section)}
      </Button>

      <div className="mt-4 flex flex-wrap gap-6">
        <BookCover book={book} className="w-40 shrink-0 text-6xl" />
        <div className="min-w-0 flex-1">
          <h2 data-testid="detail-title" className="text-2xl font-semibold leading-tight">
            {book.title}
          </h2>
          <p className="mt-1 text-muted-foreground">{book.author ?? "Unknown author"}</p>
          {book.format === "pdf" && (
            <Badge variant="secondary" className="mt-2">
              PDF
            </Badge>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              data-testid="detail-continue"
              onClick={() => dispatch({ type: "open-reader", bookId: book.id })}
            >
              <BookOpen data-icon="inline-start" />
              Continue Reading
            </Button>
            <Button
              variant="outline"
              data-testid="detail-edit"
              disabled
              title="Metadata editing will be connected to the Rust backend"
            >
              <Pencil data-icon="inline-start" />
              Edit Metadata
            </Button>
          </div>
        </div>
      </div>

      {book.description && (
        <div className="mt-8">
          <h3 className="text-sm font-medium text-muted-foreground">Description</h3>
          <p className="mt-2 text-sm leading-relaxed">{book.description}</p>
        </div>
      )}

      <div className="mt-8">
        <h3 className="text-sm font-medium text-muted-foreground">Details</h3>
        <dl
          data-testid="detail-facts"
          className="mt-2 grid grid-cols-[8rem_1fr] items-baseline gap-x-4 gap-y-1.5 text-sm"
        >
          {facts.map(([label, value]) => (
            <Fragment key={label}>
              <dt className="text-muted-foreground">{label}</dt>
              <dd className={label === "File" ? "break-all" : undefined}>{value}</dd>
            </Fragment>
          ))}
        </dl>
      </div>

      <div className="mt-8">
        <h3 className="text-sm font-medium text-muted-foreground">Collections</h3>
        <div data-testid="detail-collections" className="mt-2">
          <p className="text-sm text-muted-foreground">
            No collections yet — collections are not connected to the backend yet.
          </p>
        </div>
      </div>
    </section>
  );
}
