import { invoke } from "@tauri-apps/api/core";
import type { Book, BookToc, ImportReport, LibraryStats } from "@/types/domain";

export type { Book, BookFormat, BookToc, ImportReport, LibraryStats } from "@/types/domain";

export function getLibraryStats(): Promise<LibraryStats> {
  return invoke("get_library_stats");
}

export function listBooks(): Promise<Book[]> {
  return invoke("list_books");
}

export function scanLibrary(path: string): Promise<ImportReport> {
  return invoke("scan_library", { path });
}

export function getBookToc(bookId: number): Promise<BookToc> {
  return invoke("get_book_toc", { bookId });
}
