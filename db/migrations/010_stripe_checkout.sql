-- Real payments: each held spot gets its own Stripe Checkout page (registrations.stripe_session_id already exists).
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS checkout_url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS payments_reference_once ON payments (kind, reference) WHERE provider = 'STRIPE';
