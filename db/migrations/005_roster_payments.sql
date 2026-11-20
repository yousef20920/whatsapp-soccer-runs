-- Joining and leaving games: when a spot was paid for, offered from the waitlist, or given up.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS offered_at TIMESTAMP WITH TIME ZONE; -- waitlist spot offered; hold_expires_at ends the offer
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS left_at TIMESTAMP WITH TIME ZONE;

-- Every payment and refund. Test (MOCK) payments for now; Stripe payments later.
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    match_id INT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
    discord_user_id VARCHAR(32) NOT NULL,
    kind VARCHAR(10) NOT NULL,     -- PAYMENT, REFUND
    amount_cents INT NOT NULL,
    provider VARCHAR(10) NOT NULL, -- MOCK, STRIPE
    reference VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS payments_match_idx ON payments (match_id);
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- A once-a-minute job (set up by scripts/schedule-sweep.mjs) calls /api/sweep to release
-- unpaid holds, offer free spots to the waitlist and close games at kickoff.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
