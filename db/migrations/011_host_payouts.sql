-- Host payouts (Stripe Connect): each organizer who hosts games gets their own Stripe account, and after
-- kickoff each player's payment (minus Stripe's fee) is sent to the host of that game.
CREATE TABLE IF NOT EXISTS hosts (
    discord_user_id VARCHAR(32) PRIMARY KEY,
    stripe_account_id VARCHAR(255) NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE hosts ENABLE ROW LEVEL SECURITY;

-- One row per player payment once it's settled with the host: sent (transfer_id set) or nothing to send
-- (transfer_id NULL, e.g. the player left and was refunded).
CREATE TABLE IF NOT EXISTS host_payouts (
    payment_id INT PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE,
    match_id INT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
    host_id VARCHAR(32) NOT NULL,
    amount_cents INT NOT NULL,
    transfer_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS host_payouts_match_idx ON host_payouts (match_id);
ALTER TABLE host_payouts ENABLE ROW LEVEL SECURITY;
