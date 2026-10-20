-- A bookmark can carry a short user label ("Key idea", "Character intro")
-- so several bookmarks in the same chapter are distinguishable. The limit
-- counts characters, matching the editor's cap; notes stay free-form and
-- unbounded in the same table.
ALTER TABLE annotations ADD COLUMN label TEXT
    CHECK (label IS NULL OR length(label) <= 50);
