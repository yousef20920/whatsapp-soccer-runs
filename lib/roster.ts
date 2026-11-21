import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sql, type Match, type Registration } from "./db.js";
import { discord } from "./discord.js";
import { lobbyMessage } from "./lobby.js";
import { cardFeeCents, LEAVE_CUTOFF_HOURS, money } from "./pricing.js";
import { createCheckout, expireCheckout, getCheckout, refund as stripeRefund, stripeEnabled, stripeTestMode, type CheckoutSession } from "./stripe.js";
import { torontoLabel } from "./time.js";

// Joining and leaving games (first come, first served):
// - Claim & Pay holds a spot for HOLD_MINUTES while the player pays. If the game is full they join the waitlist.
// - When a spot frees up, the next waitlisted player is DMed and gets it for OFFER_MINUTES.
// - Paid players can leave until LEAVE_CUTOFF_HOURS before kickoff and are refunded minus the card fee.
// Payments: with STRIPE_SECRET_KEY set, each hold gets its own Stripe Checkout page and SORY checks Stripe
// to confirm the payment (from the return page and the once-a-minute sweep). Without it, a test Pay button
// records MOCK payments.

export const HOLD_MINUTES = 5;
export const OFFER_MINUTES = 10;

type Tx = postgres.TransactionSql;
export interface Player {
  id: string;
  name: string;
}
/** What to show the player who pressed the button. */
export interface Result {
  content: string;
  components?: unknown[];
}
interface Effects {
  changed: boolean; // the lobby card needs redrawing
  offers: string[]; // waitlisted players to DM about a free spot
  dms: { userId: string; content: string }[]; // receipts and late-payment refunds
}
type Reg = Registration & { id: number; stripe_session_id: string | null; checkout_url: string | null };

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);
const unix = (d: Date | string) => Math.floor(new Date(d).getTime() / 1000);
const started = (m: Match) => new Date(m.kickoff_time).getTime() <= Date.now();
const title = (m: Match) => `${m.facility_name} · ${m.court_name}`;
const when = (m: Match) => torontoLabel(new Date(m.kickoff_time));

/** A line under payment messages saying whether real money moves. */
function paymentNote(): string {
  if (!stripeEnabled()) return "-# Test mode: no card is charged and no real money moves.";
  if (stripeTestMode()) return "-# Stripe test mode: pay with card 4242 4242 4242 4242, any future date and any CVC. No real money moves.";
  return "";
}
/** A line under receipts and refunds saying whether real money moved. */
const doneNote = () =>
  !stripeEnabled() ? "-# Test mode: no real money moved." : stripeTestMode() ? "-# Stripe test mode: no real money moved." : "";
const modeNote = () => (!stripeEnabled() ? " (test mode, no real money moved)" : stripeTestMode() ? " (Stripe test mode)" : "");
const lines = (...parts: string[]) => parts.filter(Boolean).join("\n");

/**
 * Runs `action` with the game locked so two players can't take the same spot, after tidying it up
 * (expired holds, waitlist offers). Redraws the lobby and sends DMs once the change is saved.
 */
async function withGame(matchId: number, action: (tx: Tx, match: Match, fx: Effects) => Promise<Result>): Promise<Result> {
  const fx: Effects = { changed: false, offers: [], dms: [] };
  let match: Match | undefined;
  const result = (await sql.begin(async (tx) => {
    [match] = await tx<Match[]>`SELECT * FROM matches WHERE match_id = ${matchId} FOR UPDATE`;
    if (!match) return { content: "That game doesn't exist any more." };
    await tidy(tx, match, fx);
    return action(tx, match, fx);
  })) as Result;
  if (match) await announce(match, fx);
  return result;
}

/** Releases unpaid holds that ran out, then offers free spots to the waitlist. */
async function tidy(tx: Tx, match: Match, fx: Effects) {
  const lapsed = await tx<Reg[]>`
    SELECT * FROM registrations WHERE match_id = ${match.match_id} AND status = 'PENDING' AND hold_expires_at <= ${new Date()}`;
  for (const reg of lapsed) {
    if (await endCheckout(tx, match, reg, fx)) continue; // paid just in time: they're in
    await releaseHold(tx, reg.id);
    fx.changed = true;
  }
  await offerFreeSpots(tx, match, fx);
}

const releaseHold = (tx: Tx, regId: number) => tx`
  UPDATE registrations SET status = 'CANCELLED', hold_expires_at = NULL, checkout_url = NULL, left_at = ${new Date()} WHERE id = ${regId}`;

/** Gives a held spot its own Stripe Checkout page (when Stripe is on). Returns the page's link. */
async function attachCheckout(tx: Tx, match: Match, userId: string, holdUntil: Date): Promise<string | null> {
  if (!stripeEnabled()) return null;
  const session = await createCheckout({
    matchId: match.match_id,
    userId,
    amountCents: match.checkout_price_cents,
    description: `NASORY Runs · Match #${match.match_id} · ${title(match)} · ${when(match)}`,
    holdKey: `hold-${match.match_id}-${userId}-${holdUntil.getTime()}`,
  });
  await tx`
    UPDATE registrations SET stripe_session_id = ${session.id}, checkout_url = ${session.url}
    WHERE match_id = ${match.match_id} AND discord_user_id = ${userId}`;
  return session.url;
}

/** Closes a hold's Checkout page. If it turns out it was paid, records the payment and returns true. */
async function endCheckout(tx: Tx, match: Match, reg: Reg, fx: Effects): Promise<boolean> {
  if (!reg.stripe_session_id || !stripeEnabled()) return false;
  const session = await expireCheckout(reg.stripe_session_id);
  if (session.payment_status !== "paid") return false;
  await recordStripePayment(tx, match, reg.discord_user_id, session, fx);
  return true;
}

/** Checks open Checkout pages for payments that came in (e.g. the player closed the tab before returning). */
async function checkOpenCheckouts(tx: Tx, match: Match, fx: Effects) {
  if (!stripeEnabled()) return;
  const open = await tx<Reg[]>`
    SELECT * FROM registrations WHERE match_id = ${match.match_id} AND status = 'PENDING' AND stripe_session_id IS NOT NULL`;
  for (const reg of open) {
    const session = await getCheckout(reg.stripe_session_id!);
    if (session.payment_status === "paid") await recordStripePayment(tx, match, reg.discord_user_id, session, fx);
  }
}

/**
 * Records a completed Stripe payment once. The player gets the spot if they still hold it or one is free;
 * otherwise (the game filled up, was cancelled, or they'd already paid) the payment is refunded in full.
 */
async function recordStripePayment(tx: Tx, match: Match, userId: string, session: CheckoutSession, fx: Effects): Promise<"confirmed" | "refunded" | "already"> {
  const intent = session.payment_intent!;
  const amount = session.amount_total ?? match.checkout_price_cents;
  const inserted = await tx`
    INSERT INTO payments (match_id, discord_user_id, kind, amount_cents, provider, reference)
    VALUES (${match.match_id}, ${userId}, 'PAYMENT', ${amount}, 'STRIPE', ${intent})
    ON CONFLICT DO NOTHING RETURNING id`;
  if (!inserted.length) return "already";

  const reg = await registrationOf(tx, match.match_id, userId);
  const canTake =
    match.status === "OPEN" && !started(match) && reg?.status !== "CONFIRMED" &&
    (reg?.status === "PENDING" || (await takenSpots(tx, match.match_id)) < match.max_players);
  if (canTake) {
    await tx`
      UPDATE registrations SET status = 'CONFIRMED', hold_expires_at = NULL, checkout_url = NULL, paid_at = ${new Date()}, left_at = NULL
      WHERE match_id = ${match.match_id} AND discord_user_id = ${userId}`;
    fx.changed = true;
    fx.dms.push({ userId, content: receipt(match, amount) });
    return "confirmed";
  }

  const back = await stripeRefund(intent, amount, `late-${intent}`);
  await tx`
    INSERT INTO payments (match_id, discord_user_id, kind, amount_cents, provider, reference)
    VALUES (${match.match_id}, ${userId}, 'REFUND', ${amount}, 'STRIPE', ${back.id})`;
  const why =
    reg?.status === "CONFIRMED"
      ? "You'd already paid for this game, so this second payment"
      : match.status === "CANCELLED"
        ? "The game was cancelled, so your payment"
        : "Your payment came in after your hold ran out and the game had filled up, so it";
  fx.dms.push({ userId, content: `↩️ ${why} was refunded in full (${money(amount)}): ${title(match)}, ${when(match)}.` });
  return "refunded";
}

function receipt(match: Match, amountCents: number): string {
  return lines(
    `✅ **You're in!** ${title(match)}, ${when(match)}.`,
    `Paid ${money(amountCents)}. Need to drop out? Press **Leave Match** on the game up to ${LEAVE_CUTOFF_HOURS} hours before kickoff.`,
    doneNote(),
  );
}

async function offerFreeSpots(tx: Tx, match: Match, fx: Effects) {
  if (match.status !== "OPEN" || started(match)) return;
  const free = match.max_players - (await takenSpots(tx, match.match_id));
  if (free <= 0) return;
  const until = minutesFromNow(OFFER_MINUTES);
  const offered = await tx<{ discord_user_id: string }[]>`
    UPDATE registrations SET status = 'PENDING', offered_at = ${new Date()}, hold_expires_at = ${until}
    WHERE id IN (SELECT id FROM registrations WHERE match_id = ${match.match_id} AND status = 'WAITLIST' ORDER BY created_at LIMIT ${free})
    RETURNING discord_user_id`;
  for (const o of offered) await attachCheckout(tx, match, o.discord_user_id, until);
  if (offered.length) fx.changed = true;
  fx.offers.push(...offered.map((r) => r.discord_user_id));
}

async function takenSpots(tx: Tx, matchId: number): Promise<number> {
  const [{ n }] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM registrations WHERE match_id = ${matchId} AND status IN ('CONFIRMED', 'PENDING')`;
  return n;
}

async function registrationOf(tx: Tx, matchId: number, userId: string) {
  const [reg] = await tx<Reg[]>`
    SELECT * FROM registrations WHERE match_id = ${matchId} AND discord_user_id = ${userId}`;
  return reg;
}

async function waitlistPosition(tx: Tx, matchId: number, userId: string): Promise<number> {
  const [{ n }] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM registrations
    WHERE match_id = ${matchId} AND status = 'WAITLIST'
      AND created_at <= (SELECT created_at FROM registrations WHERE match_id = ${matchId} AND discord_user_id = ${userId})`;
  return n;
}

/** The payment for the player's current spot (earlier spots they left were already refunded). */
async function latestPayment(tx: Tx, matchId: number, userId: string) {
  const [payment] = await tx<{ id: number; amount_cents: number; provider: "MOCK" | "STRIPE"; reference: string }[]>`
    SELECT id, amount_cents, provider, reference FROM payments
    WHERE match_id = ${matchId} AND discord_user_id = ${userId} AND kind = 'PAYMENT' ORDER BY id DESC LIMIT 1`;
  return payment;
}

/** Sends money back the way it came in and records it. */
async function refundPayment(tx: Tx, matchId: number, userId: string, payment: { id: number; provider: string; reference: string }, cents: number, why: string) {
  if (cents <= 0) return;
  const reference =
    payment.provider === "STRIPE" ? (await stripeRefund(payment.reference, cents, `${why}-${payment.id}`)).id : `mock_${randomUUID()}`;
  await tx`
    INSERT INTO payments (match_id, discord_user_id, kind, amount_cents, provider, reference)
    VALUES (${matchId}, ${userId}, 'REFUND', ${cents}, ${payment.provider}, ${reference})`;
}

function cancelledText(match: Match): string {
  return `❌ This game was cancelled${match.cancel_reason ? ` (${match.cancel_reason})` : ""}. Everyone who paid was refunded in full.`;
}

function closedText(match: Match): string {
  if (match.status === "CANCELLED") return cancelledText(match);
  if (match.status === "DRAFT") return "This game isn't open yet.";
  return "This game has started, so the roster is closed.";
}

function payPrompt(match: Match, holdUntil: Date | string, offered: boolean, checkoutUrl: string | null): Result {
  const price = money(match.checkout_price_cents);
  const payButton = checkoutUrl
    ? { type: 2, style: 5, label: `Pay ${price}`, url: checkoutUrl }
    : { type: 2, style: 3, label: `Pay ${price} (test)`, custom_id: `pay:${match.match_id}` };
  return {
    content: lines(
      offered ? `🎉 **A spot opened up for you** in ${title(match)}, ${when(match)}.` : `⏳ **Spot held for you** in ${title(match)}, ${when(match)}.`,
      `Pay by <t:${unix(holdUntil)}:t> (<t:${unix(holdUntil)}:R>) to lock it in, or it goes to the next person.` +
        (checkoutUrl ? " Pay opens Stripe's secure checkout; you'll get a DM once it goes through." : ""),
      paymentNote(),
    ),
    components: [
      { type: 1, components: [payButton, { type: 2, style: 2, label: offered ? "No thanks" : "Cancel", custom_id: `drop:${match.match_id}` }] },
    ],
  };
}

/** Claim & Pay on the lobby: hold a spot, or join the waitlist when the game is full. */
export function claim(matchId: number, player: Player): Promise<Result> {
  return withGame(matchId, async (tx, match, fx) => {
    if (match.status !== "OPEN" || started(match)) return { content: closedText(match) };
    const reg = await registrationOf(tx, matchId, player.id);
    if (reg?.status === "CONFIRMED") return { content: "✅ You're already in this game." };
    if (reg?.status === "PENDING") return payPrompt(match, reg.hold_expires_at!, !!reg.offered_at, reg.checkout_url);
    if (reg?.status === "WAITLIST") {
      return { content: `📋 You're #${await waitlistPosition(tx, matchId, player.id)} on the waitlist. I'll DM you if a spot opens.` };
    }

    const full = (await takenSpots(tx, matchId)) >= match.max_players;
    const holdUntil = full ? null : minutesFromNow(HOLD_MINUTES);
    await tx`
      INSERT INTO registrations (match_id, discord_user_id, discord_username, status, hold_expires_at, created_at)
      VALUES (${matchId}, ${player.id}, ${player.name}, ${full ? "WAITLIST" : "PENDING"}, ${holdUntil}, ${new Date()})
      ON CONFLICT (match_id, discord_user_id) DO UPDATE SET
        discord_username = EXCLUDED.discord_username, status = EXCLUDED.status, hold_expires_at = EXCLUDED.hold_expires_at,
        created_at = EXCLUDED.created_at, offered_at = NULL, paid_at = NULL, left_at = NULL,
        stripe_session_id = NULL, checkout_url = NULL`;
    fx.changed = true;
    if (!full) return payPrompt(match, holdUntil!, false, await attachCheckout(tx, match, player.id, holdUntil!));
    return {
      content: `📋 The game is full. You're **#${await waitlistPosition(tx, matchId, player.id)} on the waitlist**. If a spot opens I'll DM you and hold it for ${OFFER_MINUTES} minutes.`,
    };
  });
}

/** The test Pay button (only shown when Stripe isn't set up): records a MOCK payment. */
export function pay(matchId: number, player: Player): Promise<Result> {
  return withGame(matchId, async (tx, match, fx) => {
    if (match.status === "CANCELLED") return { content: cancelledText(match), components: [] };
    const reg = await registrationOf(tx, matchId, player.id);
    if (reg?.status === "CONFIRMED") return { content: "✅ You've already paid. You're in this game.", components: [] };
    if (reg?.status !== "PENDING") {
      return {
        content: `⌛ Your hold ran out, so the spot was released. Press **Claim & Pay** on the game to try again.`,
        components: [],
      };
    }
    if (stripeEnabled()) return payPrompt(match, reg.hold_expires_at!, !!reg.offered_at, reg.checkout_url); // real payments are on

    const amount = match.checkout_price_cents;
    await tx`
      INSERT INTO payments (match_id, discord_user_id, kind, amount_cents, provider, reference)
      VALUES (${matchId}, ${player.id}, 'PAYMENT', ${amount}, 'MOCK', ${`mock_${randomUUID()}`})`;
    await tx`
      UPDATE registrations SET status = 'CONFIRMED', hold_expires_at = NULL, paid_at = ${new Date()}
      WHERE match_id = ${matchId} AND discord_user_id = ${player.id}`;
    fx.changed = true;
    return { content: receipt(match, amount), components: [] };
  });
}

/** Leave Match, Cancel or No thanks. Paid players are asked to confirm first (see leaveConfirmed). */
export function leave(matchId: number, player: Player): Promise<Result> {
  return withGame(matchId, async (tx, match, fx) => {
    if (match.status === "CANCELLED") return { content: cancelledText(match), components: [] };
    const reg = await registrationOf(tx, matchId, player.id);
    if (!reg || reg.status === "CANCELLED") return { content: "You're not on this game's roster.", components: [] };

    if (reg.status === "PENDING" && (await endCheckout(tx, match, reg, fx))) {
      return { content: "✅ Your payment already went through, so you're in. To drop out, press **Leave Match** on the game.", components: [] };
    }
    if (reg.status === "WAITLIST" || reg.status === "PENDING") {
      await releaseHold(tx, reg.id);
      fx.changed = true;
      await offerFreeSpots(tx, match, fx);
      return {
        content: reg.status === "WAITLIST" ? "👋 You're off the waitlist." : "👋 Spot released. You weren't charged.",
        components: [],
      };
    }

    const late = cutoffPassed(match);
    if (late) return { content: late, components: [] };
    const paid = (await latestPayment(tx, matchId, player.id))?.amount_cents ?? 0;
    const refund = Math.max(0, paid - cardFeeCents(paid));
    return {
      content: `Leave ${title(match)}, ${torontoLabel(new Date(match.kickoff_time))}? You'll get **${money(refund)}** back (your ${money(paid)} minus the ${money(paid - refund)} card fee).`,
      components: [
        {
          type: 1,
          components: [
            { type: 2, style: 4, label: `Yes, leave (refund ${money(refund)})`, custom_id: `leave-yes:${matchId}` },
            { type: 2, style: 2, label: "Stay in", custom_id: `stay:${matchId}` },
          ],
        },
      ],
    };
  });
}

/** "Yes, leave" from the confirmation: refund minus the card fee and pass the spot on. */
export function leaveConfirmed(matchId: number, player: Player): Promise<Result> {
  return withGame(matchId, async (tx, match, fx) => {
    if (match.status === "CANCELLED") return { content: cancelledText(match), components: [] };
    const reg = await registrationOf(tx, matchId, player.id);
    if (reg?.status !== "CONFIRMED") return { content: "You're not on this game's roster.", components: [] };
    const late = cutoffPassed(match);
    if (late) return { content: late, components: [] };

    const payment = await latestPayment(tx, matchId, player.id);
    const paid = payment?.amount_cents ?? 0;
    const refund = Math.max(0, paid - cardFeeCents(paid));
    if (payment) await refundPayment(tx, matchId, player.id, payment, refund, "leave");
    await tx`
      UPDATE registrations SET status = 'CANCELLED', paid_at = NULL, left_at = ${new Date()}
      WHERE match_id = ${matchId} AND discord_user_id = ${player.id}`;
    fx.changed = true;
    await offerFreeSpots(tx, match, fx);
    return {
      content: lines(
        `👋 You've left Match #${matchId}. Refund: **${money(refund)}** (your ${money(paid)} minus the ${money(paid - refund)} card fee).`,
        stripeEnabled() ? "-# Card refunds usually show up in 5 to 10 business days." : "",
        doneNote(),
      ),
      components: [],
    };
  });
}

function cutoffPassed(match: Match): string | null {
  const minutesLeft = (new Date(match.kickoff_time).getTime() - Date.now()) / 60_000;
  return minutesLeft <= LEAVE_CUTOFF_HOURS * 60
    ? `Cancellations close ${LEAVE_CUTOFF_HOURS} hours before kickoff. Post in chat to find a sub!`
    : null;
}

/**
 * Called every minute (api/sweep): releases expired holds, moves the waitlist up and
 * closes games at kickoff. Returns how many games it looked at.
 */
export async function sweep(): Promise<number> {
  const due = await sql<{ match_id: number }[]>`
    SELECT m.match_id FROM matches m
    WHERE m.status = 'OPEN' AND (
      m.kickoff_time <= ${new Date()}
      OR EXISTS (SELECT 1 FROM registrations r WHERE r.match_id = m.match_id AND r.status = 'PENDING'
                 AND (r.hold_expires_at <= ${new Date()} OR r.stripe_session_id IS NOT NULL))
      OR (EXISTS (SELECT 1 FROM registrations r WHERE r.match_id = m.match_id AND r.status = 'WAITLIST')
          AND (SELECT count(*) FROM registrations r WHERE r.match_id = m.match_id AND r.status IN ('CONFIRMED', 'PENDING')) < m.max_players)
    )`;
  for (const { match_id } of due) {
    await withGame(match_id, async (tx, match, fx) => {
      await checkOpenCheckouts(tx, match, fx);
      if (match.status === "OPEN" && started(match)) {
        const holds = await tx<Reg[]>`SELECT * FROM registrations WHERE match_id = ${match_id} AND status = 'PENDING'`;
        for (const reg of holds) if (!(await endCheckout(tx, match, reg, fx))) await releaseHold(tx, reg.id);
        await tx`UPDATE matches SET status = 'LOCKED' WHERE match_id = ${match_id}`;
        fx.changed = true;
      }
      return { content: "" };
    }).catch((err) => console.error(`Sweep of Match #${match_id} failed`, err));
  }
  return due.length;
}

/** Everyone still on the game (paid, holding a spot or waitlisted), in roster order. */
export function rosterOf(matchId: number) {
  return sql<Registration[]>`
    SELECT discord_user_id, discord_username, status, hold_expires_at, offered_at, paid_at FROM registrations
    WHERE match_id = ${matchId} AND status <> 'CANCELLED'
    ORDER BY coalesce(paid_at, created_at)`;
}

/** After a change is saved: redraw the lobby card and DM waitlisted players about their spot. */
async function announce(before: Match, fx: Effects) {
  for (const dm of fx.dms) await sendDm(dm.userId, dm.content);
  if (!fx.changed && !fx.offers.length) return;
  const [match] = await sql<Match[]>`SELECT * FROM matches WHERE match_id = ${before.match_id}`;
  if (fx.changed && match.channel_id && match.message_id) {
    await discord("PATCH", `/channels/${match.channel_id}/messages/${match.message_id}`, lobbyMessage(match, await rosterOf(match.match_id))).catch(
      (err) => console.error("Couldn't redraw the lobby", err),
    );
  }
  for (const userId of fx.offers) await offerSpot(match, userId);
}

async function sendDm(userId: string, content: string) {
  try {
    const dm = await discord<{ id: string }>("POST", "/users/@me/channels", { recipient_id: userId });
    await discord("POST", `/channels/${dm.id}/messages`, { content, allowed_mentions: { parse: [] } });
  } catch (err) {
    console.error(`Couldn't DM ${userId}`, err);
  }
}

/**
 * Stripe's return page (api/paid): checks the Checkout session with Stripe and records the payment.
 * "paid" means the player has the spot; "refunded" means it came too late and was sent back.
 */
export async function settleCheckout(sessionId: string): Promise<{ state: "paid" | "refunded" | "unpaid" | "unknown"; match?: Match }> {
  const session = await getCheckout(sessionId).catch(() => null);
  const matchId = Number(session?.metadata.match_id);
  const userId = session?.metadata.discord_user_id;
  if (!session || !matchId || !userId) return { state: "unknown" };
  let game: Match | undefined;
  let state: "paid" | "refunded" | "unpaid" = "unpaid";
  await withGame(matchId, async (tx, match, fx) => {
    game = match;
    if (session.payment_status === "paid") {
      await recordStripePayment(tx, match, userId, session, fx);
      // They have the spot if they're confirmed and this payment wasn't sent back.
      const reg = await registrationOf(tx, matchId, userId);
      const [sentBack] = await tx`
        SELECT 1 FROM payments WHERE match_id = ${matchId} AND discord_user_id = ${userId} AND kind = 'REFUND' AND provider = 'STRIPE'
          AND id > (SELECT id FROM payments WHERE kind = 'PAYMENT' AND provider = 'STRIPE' AND reference = ${session.payment_intent})`;
      state = reg?.status === "CONFIRMED" && !sentBack ? "paid" : "refunded";
    }
    return { content: "" };
  });
  return { state, match: game };
}

async function offerSpot(match: Match, userId: string) {
  const [reg] = await sql<Registration[]>`
    SELECT * FROM registrations WHERE match_id = ${match.match_id} AND discord_user_id = ${userId}`;
  try {
    const dm = await discord<{ id: string }>("POST", "/users/@me/channels", { recipient_id: userId });
    await discord("POST", `/channels/${dm.id}/messages`, payPrompt(match, reg.hold_expires_at!, true, (reg as Reg).checkout_url));
  } catch {
    // DMs turned off: ping them under the game instead. Claim & Pay shows them the Pay button.
    await discord("POST", `/channels/${match.channel_id}/messages`, {
      content: `<@${userId}> a spot opened up in **Match #${match.match_id}**! Press **Claim & Pay** on the game by <t:${unix(reg.hold_expires_at!)}:t> to take it.`,
      allowed_mentions: { users: [userId] },
    }).catch((err) => console.error("Couldn't tell a waitlisted player about their spot", err));
  }
}

/** /roster: who's paid, holding, waitlisted and gone, with money in and out. Organizers only. */
export async function rosterReport(matchId: number): Promise<string> {
  const [match] = await sql<Match[]>`SELECT * FROM matches WHERE match_id = ${matchId}`;
  if (!match) return `There's no Match #${matchId}.`;
  type Row = Registration & { left_at: Date | null };
  const regs = await sql<Row[]>`
    SELECT * FROM registrations WHERE match_id = ${matchId} ORDER BY coalesce(paid_at, created_at)`;
  const sums = await sql<{ discord_user_id: string; paid: number; refunded: number }[]>`
    SELECT discord_user_id,
           coalesce(sum(amount_cents) FILTER (WHERE kind = 'PAYMENT'), 0)::int AS paid,
           coalesce(sum(amount_cents) FILTER (WHERE kind = 'REFUND'), 0)::int AS refunded
    FROM payments WHERE match_id = ${matchId} GROUP BY discord_user_id`;
  const byUser = new Map(sums.map((m) => [m.discord_user_id, m]));
  const list = (rows: Row[], line: (r: Row, i: number) => string) =>
    rows.length ? rows.map(line).join("\n") : "-# none";

  const paid = regs.filter((r) => r.status === "CONFIRMED");
  const holding = regs.filter((r) => r.status === "PENDING");
  const waiting = regs.filter((r) => r.status === "WAITLIST"); // already in join order
  const gone = regs.filter((r) => r.status === "CANCELLED" && byUser.get(r.discord_user_id)?.paid);
  const totalIn = sums.reduce((s, m) => s + m.paid, 0);
  const totalOut = sums.reduce((s, m) => s + m.refunded, 0);

  return [
    `**Match #${matchId}** · ${title(match)} · ${torontoLabel(new Date(match.kickoff_time))} · ${match.status.toLowerCase()}`,
    ``,
    `✅ **Paid (${paid.length}/${match.max_players})**`,
    list(paid, (r, i) => {
      const m = byUser.get(r.discord_user_id);
      return `${i + 1}. <@${r.discord_user_id}> · paid ${money(m?.paid ?? 0)}${m?.refunded ? `, ${money(m.refunded)} refunded from an earlier spot` : ""}`;
    }),
    `⏳ **Holding a spot (${holding.length})**`,
    list(holding, (r) => `<@${r.discord_user_id}> · ${r.offered_at ? "offered from waitlist" : "paying"}, until <t:${unix(r.hold_expires_at!)}:t>`),
    `📋 **Waitlist (${waiting.length})**`,
    list(waiting, (r, i) => `${i + 1}. <@${r.discord_user_id}>`),
    `👋 **Left (${gone.length})**`,
    list(gone, (r) => `<@${r.discord_user_id}> · refunded ${money(byUser.get(r.discord_user_id)?.refunded ?? 0)}`),
    ``,
    `💵 Collected **${money(totalIn - totalOut)}** (${money(totalIn)} in, ${money(totalOut)} refunded) · field costs ${money(match.field_cost_cents)}`,
    !stripeEnabled() ? "-# Test mode: no real money moved." : stripeTestMode() ? "-# Stripe test mode: no real money moved." : "",
  ].join("\n");
}

/** What cancelling would do, for the organizer's "are you sure?" prompt. */
export async function cancelPreview(matchId: number): Promise<{ match: Match; paidPlayers: number; refundCents: number; others: number } | null> {
  const [match] = await sql<Match[]>`SELECT * FROM matches WHERE match_id = ${matchId}`;
  if (!match) return null;
  const [row] = await sql<{ paid_players: number; refund: number; others: number }[]>`
    SELECT
      (SELECT count(*)::int FROM registrations WHERE match_id = ${matchId} AND status = 'CONFIRMED') AS paid_players,
      (SELECT coalesce(sum(lp.amount_cents), 0)::int FROM registrations r
         JOIN LATERAL (SELECT amount_cents FROM payments p WHERE p.match_id = r.match_id AND p.discord_user_id = r.discord_user_id
                       AND p.kind = 'PAYMENT' ORDER BY p.id DESC LIMIT 1) lp ON true
         WHERE r.match_id = ${matchId} AND r.status = 'CONFIRMED') AS refund, -- each paid player's current spot
      (SELECT count(*)::int FROM registrations WHERE match_id = ${matchId} AND status IN ('PENDING', 'WAITLIST')) AS others`;
  return { match, paidPlayers: row.paid_players, refundCents: row.refund, others: row.others };
}

/**
 * Cancels a game: everyone who paid gets back everything they paid for it (card fee included),
 * holds and the waitlist are cleared, the card turns grey and every player is told why.
 */
export async function cancelGame(matchId: number, reason: string | null): Promise<string> {
  type Affected = { discord_user_id: string; status: Registration["status"]; refund: number };
  let match: Match | undefined;
  let affected: Affected[] = [];
  const problem = (await sql.begin(async (tx) => {
    [match] = await tx<Match[]>`SELECT * FROM matches WHERE match_id = ${matchId} FOR UPDATE`;
    if (!match) return `There's no Match #${matchId}.`;
    if (match.status === "CANCELLED") return `Match #${matchId} is already cancelled.`;
    if (match.status === "LOCKED" || started(match)) return `Match #${matchId} has already started, so it can't be cancelled.`;

    // Close open Checkout pages first; anyone who paid in the meantime is refunded below with everyone else.
    const fx: Effects = { changed: false, offers: [], dms: [] };
    const holds = await tx<Reg[]>`SELECT * FROM registrations WHERE match_id = ${matchId} AND status = 'PENDING'`;
    for (const reg of holds) await endCheckout(tx, match, reg, fx);

    affected = await tx<Affected[]>`
      SELECT discord_user_id, status, 0 AS refund FROM registrations WHERE match_id = ${matchId} AND status <> 'CANCELLED'`;
    for (const a of affected.filter((a) => a.status === "CONFIRMED")) {
      const payment = await latestPayment(tx, matchId, a.discord_user_id);
      if (!payment) continue;
      a.refund = payment.amount_cents; // everything they paid, card fee included
      await refundPayment(tx, matchId, a.discord_user_id, payment, a.refund, "cancel");
    }
    await tx`
      UPDATE registrations SET status = 'CANCELLED', hold_expires_at = NULL, left_at = ${new Date()}
      WHERE match_id = ${matchId} AND status <> 'CANCELLED'`;
    await tx`
      UPDATE matches SET status = 'CANCELLED', cancel_reason = ${reason}, cancelled_at = ${new Date()} WHERE match_id = ${matchId}`;
    match = { ...match, status: "CANCELLED", cancel_reason: reason };
    return null;
  })) as string | null;
  if (problem || !match) return problem ?? `There's no Match #${matchId}.`;
  const game = match;

  if (game.channel_id && game.message_id) {
    await discord("PATCH", `/channels/${game.channel_id}/messages/${game.message_id}`, lobbyMessage(game, [])).catch((err) =>
      console.error("Couldn't grey out the lobby", err),
    );
  }

  const why = reason ? ` (${reason})` : "";
  const header = `❌ **Game cancelled${why}:** ${title(game)}, ${torontoLabel(new Date(game.kickoff_time))}.`;
  const unreachable: string[] = [];
  let dmed = 0;
  for (const a of affected) {
    const detail =
      a.refund > 0
        ? lines(`You've been refunded **${money(a.refund)}** in full.`, stripeEnabled() ? "-# Card refunds usually show up in 5 to 10 business days." : "", doneNote())
        : a.status === "WAITLIST"
          ? "You were on the waitlist, so there's nothing to refund."
          : "You weren't charged.";
    try {
      const dm = await discord<{ id: string }>("POST", "/users/@me/channels", { recipient_id: a.discord_user_id });
      await discord("POST", `/channels/${dm.id}/messages`, { content: `${header}\n${detail}`, allowed_mentions: { parse: [] } });
      dmed++;
    } catch {
      unreachable.push(a.discord_user_id);
    }
  }
  if (unreachable.length && game.channel_id) {
    await discord("POST", `/channels/${game.channel_id}/messages`, {
      content: `${unreachable.map((id) => `<@${id}>`).join(" ")} ${header} Anyone who paid has been refunded in full.`,
      allowed_mentions: { users: unreachable.slice(0, 100) },
    }).catch((err) => console.error("Couldn't mention players about the cancellation", err));
  }

  const paid = affected.filter((a) => a.refund > 0);
  const total = paid.reduce((s, a) => s + a.refund, 0);
  return [
    `❌ Match #${matchId} is cancelled${why}.`,
    paid.length ? `Refunded ${paid.length} player${paid.length === 1 ? "" : "s"} ${money(total)} in total${modeNote()}.` : "No one had paid yet.",
    affected.length ? `Told ${affected.length} player${affected.length === 1 ? "" : "s"}: ${dmed} by DM${unreachable.length ? `, ${unreachable.length} mentioned in #games` : ""}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
