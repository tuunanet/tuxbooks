# Importing a folder watches it

Importing a folder registers it as a watched folder: one flow does both, so
"point TuxBooks at a folder" always ends with live sync. Users disliked that
watching was invisible and had no way out, so watched folders are now listed in
Settings > Folders with an Unwatch action that keeps the books by default
(remove-from-catalog is an opt-in checkbox). We considered splitting import
from watch as separate explicit acts, and watching every folder that
contributed a book unless excluded. The split creates imported-but-unwatched
books that silently go stale, a state the UI would have to explain forever.
The inverted default makes the watch list larger and more magical. Keeping the
fusion and adding visibility plus an escape hatch fixes the two real defects,
the user cannot see the list and cannot leave, without new concepts.
