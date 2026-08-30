import { useLibrary } from "../../hooks/useLibrary";
import { Button } from "../ui/button";
import { BookCard } from "../books/BookCard";
import { EmptyLibraryState } from "./EmptyLibraryState";
import { filterBooksBySection, sectionNeedsProgressData, sectionTitle } from "./sections";
import type { LibrarySection } from "../../state/appState";

interface LibraryViewProps {
  section: LibrarySection;
}

export function LibraryView({ section }: LibraryViewProps) {
  const { books, loading, error, refresh } = useLibrary();

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

  const title = sectionTitle(section);

  if (sectionNeedsProgressData(section)) {
    return (
      <section data-testid="section-needs-progress">
        <h2 className="text-2xl font-semibold">{title}</h2>
        <p className="mt-2 max-w-md text-muted-foreground">
          This list needs reading-progress persistence from the Rust backend, which is not wired up
          yet.
        </p>
      </section>
    );
  }

  if (books.length === 0 && section.kind === "smart" && section.id === "all-books") {
    return <EmptyLibraryState />;
  }

  const visible = filterBooksBySection(books, section);

  if (visible.length === 0) {
    return (
      <section data-testid="empty-section">
        <h2 className="text-2xl font-semibold">{title}</h2>
        <p className="mt-2 text-muted-foreground">No books in this view yet.</p>
      </section>
    );
  }

  const bookWord = visible.length === 1 ? "book" : "books";
  return (
    <section data-testid="library-view">
      <header className="mb-6 flex items-baseline gap-3">
        <h2 className="text-2xl font-semibold">{title}</h2>
        <span data-testid="library-stats" className="text-sm text-muted-foreground">
          {visible.length} {bookWord}
        </span>
      </header>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
        {visible.map((book) => (
          <BookCard key={book.id} book={book} />
        ))}
      </div>
    </section>
  );
}
