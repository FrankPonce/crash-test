-- Scoring "decided/1" (test version 15): the score covers decided runs only, and coverage
-- (decided runs / applicable runs, 0-100) is stored next to it. Older runs have NULL.
ALTER TABLE runs ADD COLUMN coverage INTEGER;
