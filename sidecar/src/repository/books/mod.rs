//! Book and file-row repository. The public seam is unchanged: every item is
//! re-exported here, so `repository::books::…` paths keep working.

mod detach;
mod query;
mod write;

#[cfg(test)]
mod tests;

pub(crate) use detach::{active_path_for_uid, remember_last_known_path};
pub use detach::{
    delete_book, delete_file_row, discard_empty_durable_record, durable_id_for_uid,
    ensure_durable_record, file_ids_for_book, has_file_rows, mark_metadata_available,
    relink_target, set_availability_prefix, RelinkTarget,
};
pub use query::{
    books_owned_by, count_books, file_snapshot_by_path, find_books_with_size, get_book,
    get_book_by_file_id, get_book_by_path, list_books, list_books_in_prefix, list_cover_paths,
    list_file_snapshots, list_files_for_book, list_reading_history, search_fts, user_state,
    BookFileSnapshot,
};
pub use write::{
    active_file_id, clear_rehash_pending, durable_id_for_file, find_file_id_by_path, insert_book,
    insert_file_for_book, mark_opened, mark_rehash_pending, relink_book, update_book_by_id,
    update_book_by_path, update_file_snapshot, upsert_book, upsert_file, RelinkOutcome,
    UpsertedBook,
};
