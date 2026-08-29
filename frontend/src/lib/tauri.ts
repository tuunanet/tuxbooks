import { invoke } from "@tauri-apps/api/core";

export interface LibraryStats {
  bookCount: number;
  collectionCount: number;
}

export interface Book {
  id: number;
  path: string;
  title: string;
  subtitle: string | null;
  author: string | null;
  publisher: string | null;
  language: string | null;
  isbn: string | null;
  description: string | null;
  coverPath: string | null;
  addedAt: string;
  modifiedAt: string;
  lastOpenedAt: string | null;
}

export interface ImportReport {
  imported: number;
  updated: number;
  failed: { path: string; error: string }[];
}

export interface BookToc {
  bookId: number;
  title: string;
  chapters: string[];
}

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
