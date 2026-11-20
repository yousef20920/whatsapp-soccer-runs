-- Organizers can cancel a game: everyone who paid is refunded in full and told why.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS cancel_reason VARCHAR(100);
ALTER TABLE matches ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMP WITH TIME ZONE;
