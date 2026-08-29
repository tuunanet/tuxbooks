import { useLibrary } from "../../hooks/useLibrary";
import { Button } from "../ui/button";
import { BookCard } from "../books/BookCard";
import { EmptyLibraryState } from "./EmptyLibraryState";

export function LibraryView() {
  const { stats, books, loading, error, refresh } = useLibrary();

  if (loading) {
    return (
      <p data-testid="library-loading" className="text-muted-foreground">
        Loading library…
      </p>
    );
  }

  if (error) {
    return (
      <div
        data-testid="error-banner"
        role="alert"
        className="rounded-md border border-destructive/50 bg-destructive/10 p-4"
      >
        <p className="font-medium">Failed to load the library</p>
        <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  }

  if (books.length === 0) {
    return <EmptyLibraryState />;
  }

  const bookWord = (stats?.bookCount ?? books.length) === 1 ? "book" : "books";
  return (
    <section data-testid="library-view">
      <header className="mb-6 flex items-baseline gap-3">
        <h2 className="text-2xl font-semibold">Library</h2>
        <span data-testid="library-stats" className="text-sm text-muted-foreground">
          {stats?.bookCount ?? books.length} {bookWord}
        </span>
      </header>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
        {books.map((book) => (
          <BookCard key={book.id} book={book} />
        ))}
      </div>
    </section>
  );
}
