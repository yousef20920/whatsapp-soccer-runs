-- Poll voters don't get priority after all: they're DMed when the game is posted, then it's first come, first served.
ALTER TABLE matches DROP COLUMN IF EXISTS priority_until;
