-- Per-person cooldown on SORY's commands and buttons, so one account can't flood them.
-- One row per Discord user: how many actions they've taken in the current 30-second window.
CREATE TABLE IF NOT EXISTS rate_limits (
    discord_user_id VARCHAR(32) PRIMARY KEY,
    window_start BIGINT NOT NULL,
    hits INT NOT NULL
);
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;
