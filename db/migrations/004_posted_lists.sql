-- The last /available list posted in each channel for each search, so an unchanged list isn't posted twice.
CREATE TABLE IF NOT EXISTS posted_lists (
    channel_id VARCHAR(30) NOT NULL,
    search_key TEXT NOT NULL,       -- format|length|after|players|from|to
    results_hash CHAR(64) NOT NULL, -- openings and prices in that list
    message_id VARCHAR(30) NOT NULL,
    posted_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (channel_id, search_key)
);

ALTER TABLE posted_lists ENABLE ROW LEVEL SECURITY;
