import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Book } from "@/lib/tauri";

interface BookCardProps {
  book: Book;
}

export function BookCard({ book }: BookCardProps) {
  return (
    <Card data-testid="book-card" className="overflow-hidden">
      <div className="flex h-40 items-center justify-center bg-muted text-muted-foreground">
        {book.coverPath ? (
          <span className="text-xs">cover</span>
        ) : (
          <span className="text-3xl font-semibold opacity-30">
            {book.title.charAt(0).toUpperCase()}
          </span>
        )}
      </div>
      <CardHeader className="p-4">
        <CardTitle className="text-base">{book.title}</CardTitle>
      </CardHeader>
      <CardContent className="p-4 pt-0 text-sm text-muted-foreground">
        <p>{book.author ?? "Unknown author"}</p>
        {book.language && <p className="mt-1 text-xs uppercase">{book.language}</p>}
      </CardContent>
    </Card>
  );
}
