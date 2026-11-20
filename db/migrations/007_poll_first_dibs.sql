-- A confirmed game can come from a poll: the poll's "I'm in" voters get first dibs until priority_until.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS poll_id INT REFERENCES polls(poll_id) ON DELETE SET NULL;
ALTER TABLE matches ADD COLUMN IF NOT EXISTS priority_until TIMESTAMP WITH TIME ZONE;
ALTER TABLE polls ADD COLUMN IF NOT EXISTS match_id INT REFERENCES matches(match_id) ON DELETE SET NULL;
