-- Core schema from docs/design-doc.md (section 4), plus two per-game fields
-- (field_cost_cents, duration_minutes) since games change week to week.

CREATE TABLE IF NOT EXISTS matches (
    match_id SERIAL PRIMARY KEY,
    facility_name VARCHAR(100) NOT NULL,
    court_name VARCHAR(50) NOT NULL,
    kickoff_time TIMESTAMP WITH TIME ZONE NOT NULL,
    duration_minutes INT NOT NULL DEFAULT 60,
    max_players INT NOT NULL DEFAULT 12,
    field_cost_cents INT NOT NULL,
    base_price_cents INT NOT NULL,
    checkout_price_cents INT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT', -- DRAFT, OPEN, LOCKED, CANCELLED
    channel_id VARCHAR(32),
    message_id VARCHAR(32),
    created_by VARCHAR(32) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS registrations (
    id SERIAL PRIMARY KEY,
    match_id INT NOT NULL REFERENCES matches(match_id) ON DELETE CASCADE,
    discord_user_id VARCHAR(32) NOT NULL,
    discord_username VARCHAR(100) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, CONFIRMED, WAITLIST, CANCELLED
    stripe_session_id VARCHAR(255),
    stripe_payment_intent VARCHAR(255),
    hold_expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_match_user UNIQUE (match_id, discord_user_id)
);

-- SORY talks to Postgres directly. Turning on row level security with no policies
-- keeps Supabase's public API (anon/publishable key) from reading or writing these tables.
ALTER TABLE matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE registrations ENABLE ROW LEVEL SECURITY;
