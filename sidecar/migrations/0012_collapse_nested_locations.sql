-- A watched folder inside another watched folder is redundant: the folder
-- above already watches the whole subtree recursively, and the startup and
-- catch-up reconcile already walk it. The nested row adds nothing the
-- library can use, and it cannot be unwatched on its own, since removing it
-- alone would leave the folder above free to re-import its books (ADR 0010).
--
-- So the watch list flattens to folders that are not inside another watched
-- folder. This is deliberately NOT an unwatch: unwatch removes a folder's
-- books along with the row, and this removes only the redundant row. The
-- books stay exactly where they are, simply owned by the folder above
-- instead, so no catalog row, reading progress, or annotation is lost.
--
-- Nothing can be orphaned by this pass: a row is deleted only when a folder
-- above it is registered, so every book under it keeps an owner.
--
-- The separator split matches `owning_location` and migration 0011: a
-- sibling like /libx is not inside /lib.
DELETE FROM library_locations
WHERE EXISTS (
    SELECT 1
    FROM library_locations ancestor
    WHERE ancestor.path <> library_locations.path
      AND substr(library_locations.path, 1, length(ancestor.path) + 1)
          = ancestor.path || '/'
);
