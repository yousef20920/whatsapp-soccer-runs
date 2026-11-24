-- Payout approval: after kickoff SORY asks the Discord server owner (in #bot-logs) to approve each game's
-- payout to its host. Nothing is sent to the host until approved_at is set.
CREATE TABLE IF NOT EXISTS payout_approvals (
    match_id INT PRIMARY KEY REFERENCES matches(match_id) ON DELETE CASCADE,
    message_id VARCHAR(32),
    approved_by VARCHAR(32),
    approved_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE payout_approvals ENABLE ROW LEVEL SECURITY;
