# Product Design Document: Discord Soccer Booking & Roster Bot (V1–V3)

Automated venue scraping, payment collection, and dynamic roster management for recreational soccer groups.

## 1. Product Overview & Objectives

### Target Audience

A 160-member recreational soccer community requiring consistent weekly court allocations and transparent payment collection.

### Core Problem

- **Manual Court Discovery:** Admins must manually monitor booking portals to catch open court slots.
- **Chat Clutter:** Reliance on manual copy-pasting of rosters leads to chat pollution and miscommunication regarding who actually holds a confirmed spot.
- **Financial Friction:** Chasing individual e-transfers or peer-to-peer payments manually creates admin overhead and financial liability for unpaid spots.

### Core Solution

An integrated Discord bot that scrapes facility portals for open court times, guides an admin to the final checkout stage, opens a verified Stripe payment lobby upon booking confirmation, and enforces real-time first-come-first-served (FCFS) roster management, waitlisting, and cutoff-managed self-cancellations.

### Success Metrics

- **Zero Manual Roster Edits:** 100% of player additions, drops, and waitlists handled programmatically.
- **100% Automated Payment Verification:** Zero confirmed spots granted without prior webhook-verified Stripe transaction completion.
- **High-Performance Lookups:** Facility availability queries (`!available`) complete and render within 3 seconds.

## 2. End-to-End User & Admin Flow

### Step 1: Discovery

**Command:** `!available [date]`

- Scrapes the target facility portal for available court slots on the specified date (defaults to current date if omitted).
- Posts a structured Discord Embed detailing court identifiers, available time windows, total facility cost, and calculated per-player split options.

### Step 2: Admin Pre-Booking

**Command:** `!reserve <court_id> <time_slot> [max_players]` (Requires @Organizer / Admin Role)

- Validates caller permissions against required Discord role hierarchy.
- Executes browser automation to navigate the facility portal up to the final checkout state.
- Returns an ephemeral payload (visible strictly to the initiating admin) containing the direct checkout URL.
- Instantiates a `DRAFT` match record in the database (e.g., Match #42).
- Public payment lobbies remain inactive during this stage to prevent premature player transactions.

### Step 3: Booking Confirmation & Lobby Launch

**Command:** `!confirm <match_id>` (Requires @Organizer / Admin Role)

- Executed by the admin following successful checkout completion at the facility portal.
- Transitions Match #42 status from `DRAFT` to `OPEN`.
- Dispatches the primary Match Lobby Embed to the public channel featuring:
  - Facility name, court assignment, and date/time details.
  - Financial metrics (Total court fee, per-player cost inclusive of processing fees).
  - Real-time roster tracker (e.g., `0/12 Confirmed`).
  - Action components: **Claim & Pay ($15.75)** and **Leave Match**.

### Step 4: Player Claim & Stripe Webhook Verification (FCFS)

**Claiming a Spot:**

- Player clicks **Claim & Pay**. System evaluates if `confirmed_count + active_holds < max_players`.
- If capacity exists, creates a 5-minute soft hold (`PENDING` status) and returns an ephemeral Stripe Checkout URL containing encoded reference parameters (`client_reference_id = match_id:discord_user_id`, `expires_at = now + 5m`).
- If capacity is reached (12/12), automatically appends the user to the ordered Waitlist queue.

**Payment Verification:**

- Upon successful transaction, Stripe dispatches a `checkout.session.completed` event to the API gateway.
- Gateway validates cryptographic signatures, upgrades player registration status to `CONFIRMED`, and updates the public Match Lobby Embed in place (e.g., `1/12 Confirmed: @PlayerName`).

### Step 5: Per-User Self-Cancellation

**Command:** Interactive **Leave Match** button or `!leave`

- **Cutoff Enforcement:** Strict 60-minute pre-kickoff boundary.
- **Late Cancellation** (`kickoff_time - now <= 60 mins`): Request rejected ephemerally ("Cancellations close 1 hour before kickoff. Post in chat to find a sub!").
- **Timely Cancellation** (`kickoff_time - now > 60 mins`):
  - Removes user from `CONFIRMED` state and decrements active roster count (e.g., to 11/12).
  - Issues an automated partial refund via Stripe (Total Paid − Processing Fee, e.g., $15.00 net return on $15.75) or increments an internal ledger balance.
  - Automatically dispatches a private 10-minute checkout invitation to Waitlist position #1 before releasing the slot to the public pool.

## 3. System Architecture & Logic Units

| Logic Unit | Responsibility | Implementation Notes |
|---|---|---|
| 1. Discord Gateway & UI | Handles command routing (`!available`, `!reserve`, `!confirm`, `!cancel`), role validation, UI interaction handlers, and dynamic embed updates. | Built via discord.py or discord.js. Ephemeral response modes leveraged for admin checkout URLs and personalized payment links to eliminate channel clutter. |
| 2. Facility Scraper | Fetches real-time slot availability metrics and drives portal navigation to the final payment boundary. | Implemented with Playwright / Puppeteer. Uses deterministic browser automation for reliable execution on structured booking systems. |
| 3. Payment & Webhook Service | Provisions time-bound Stripe Checkout instances, processes `checkout.session.completed` and `checkout.session.expired` payloads, and handles refund operations. | FastAPI (Python) or Express (Node.js) web server deployed on cloud infrastructure (Railway, Fly.io, or Render) with exposed HTTPS endpoints. |
| 4. Database & Concurrency Layer | Manages persistence state and executes row-level transactional locks during slot reservation attempts. | PostgreSQL or SQLite configured with atomic transactions (`BEGIN IMMEDIATE`) to resolve race conditions during concurrent user claims. |

## 4. Core Database Schema (V1)

```sql
CREATE TABLE matches (
    match_id SERIAL PRIMARY KEY,
    facility_name VARCHAR(100) NOT NULL,
    court_name VARCHAR(50) NOT NULL,
    kickoff_time TIMESTAMP WITH TIME ZONE NOT NULL,
    max_players INT NOT NULL DEFAULT 12,
    base_price_cents INT NOT NULL,
    checkout_price_cents INT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'DRAFT', -- DRAFT, OPEN, LOCKED, CANCELLED
    channel_id VARCHAR(32),
    message_id VARCHAR(32),
    created_by VARCHAR(32) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE registrations (
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
```

## 5. Phased Roadmap

### V1: Core Admin Loop & Verified Roster (Target: Weeks 1–2)

- Deterministic browser scraper supporting `!available` query rendering and `!reserve` admin checkout link retrieval.
- Administrative `!confirm <match_id>` interface to initialize public Match Lobby embeds.
- Integration of Stripe Checkout and webhook event listeners for real-time Discord roster synchronization.
- Implementation of fee pass-through calculations (base_price + Stripe processing fee) to maintain neutral organizer liability.

### V2: Concurrency, Self-Cancel & Dedicated Payouts (Target: Weeks 3–4)

- Soft-hold expiration handler via `checkout.session.expired` webhook callbacks to release abandoned slots (5-minute TTL).
- Interactive **Leave Match** action with 60-minute pre-kickoff locking, net-of-fee refund routing, and automatic waitlist escalation.
- Integration of a dedicated business checking account and payment card linked to Stripe payouts to isolate operational funds.

### V3: Zero-Touch Auto-Booking & Multi-Facility (Target: Weeks 5+)

- Autonomous Playwright checkout pipeline triggered when pre-funded player balances cross threshold minimums.
- Multi-venue portal scraping engine expansion within `!available`.
- Historical player reliability, check-in tracking, and automated attendance metrics scoring.
