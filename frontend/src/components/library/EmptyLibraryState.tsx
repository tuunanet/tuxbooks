import { BookOpenIcon } from "../books/BookOpenIcon";

export function EmptyLibraryState() {
  return (
    <div
      data-testid="empty-library"
      className="flex h-full flex-col items-center justify-center gap-3 text-center"
    >
      <BookOpenIcon className="h-12 w-12 text-muted-foreground" />
      <h2 className="text-xl font-semibold">Your library is empty</h2>
      <p className="max-w-sm text-sm text-muted-foreground">
        Point tuxbooks at a folder of EPUB files to import your books. Books are read from disk and
        indexed locally — nothing leaves your machine.
      </p>
    </div>
  );
}
