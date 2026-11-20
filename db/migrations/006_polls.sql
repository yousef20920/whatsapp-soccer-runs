-- "Who wants to play?" polls: anyone picks a day, players answer, organizers book once enough are in.
CREATE TABLE IF NOT EXISTS polls (
    poll_id SERIAL PRIMARY KEY,
    game_day DATE NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'OPEN', -- OPEN, CLOSED
    channel_id VARCHAR(32) NOT NULL,
    message_id VARCHAR(32),
    created_by VARCHAR(32) NOT NULL,
    ready_at TIMESTAMP WITH TIME ZONE, -- when it first reached enough players (organizers were told)
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- One open poll per day.
CREATE UNIQUE INDEX IF NOT EXISTS polls_one_open_per_day ON polls (game_day) WHERE status = 'OPEN';
ALTER TABLE polls ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS poll_votes (
    poll_id INT NOT NULL REFERENCES polls(poll_id) ON DELETE CASCADE,
    discord_user_id VARCHAR(32) NOT NULL,
    discord_username VARCHAR(100) NOT NULL,
    answer VARCHAR(5) NOT NULL, -- IN, OUT
    voted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (poll_id, discord_user_id)
);
ALTER TABLE poll_votes ENABLE ROW LEVEL SECURITY;
