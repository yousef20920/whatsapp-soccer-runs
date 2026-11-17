-- What a reserved game needs to be booked: the Active Mississauga fields and the game format.
ALTER TABLE matches ADD COLUMN IF NOT EXISTS resource_ids INT[];
ALTER TABLE matches ADD COLUMN IF NOT EXISTS game_format VARCHAR(10);
