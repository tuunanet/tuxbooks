-- One-time purge (epic tuxbooks-7dx): the library is a strict mirror of the
-- watched folders. Books already sitting outside every watched location —
-- left over from the retired loose-books behaviour — leave the catalog on
-- this upgrade. Files on disk are never touched; only catalog rows go, and
-- they go through the same FK cascade the Remove command and the unwatch
-- purge use, so reading progress, annotations, and collection membership
-- travel with the row.
--
-- Membership is the separator-split ancestry rule the rest of the library
-- trusts (`owning_location` in Rust, `list_books_in_prefix` in SQL): a book
-- belongs to a watched location when its path equals the location or
-- continues under it after a '/'. A sibling like /libx is not under /lib.
DELETE FROM books
WHERE NOT EXISTS (
    SELECT 1
    FROM library_locations l
    WHERE books.path = l.path
       OR substr(books.path, 1, length(l.path) + 1) = l.path || '/'
);
