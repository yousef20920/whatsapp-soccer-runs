import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sql, type Match, type Registration } from "./db.js";
import { discord } from "./discord.js";
import { lobbyMessage } from "./lobby.js";
import { cardFeeCents, LEAVE_CUTOFF_HOURS, money } from "./pricing.js";
import { torontoLabel } from "./time.js";

// Joining and leaving games (first come, first served):
// - Claim & Pay holds a spot for HOLD_MINUTES while the player pays. If the game is full they join the waitlist.
// - When a spot frees up, the next waitlisted player is DMed and gets it for OFFER_MINUTES.
// - Paid players can leave until LEAVE_CUTOFF_HOURS before kickoff and are refunded minus the card fee.
// Payments are test (MOCK) payments for now: no card is charged. Stripe replaces pay() later.

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
}

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000);
const unix = (d: Date | string) => Math.floor(new Date(d).getTime() / 1000);
const started = (m: Match) => new Date(m.kickoff_time).getTime() <= Date.now();
const title = (m: Match) => `${m.facility_name} · ${m.court_name}`;
const testNote = "-# Test mode: no card is charged and no real money moves. Real payments come with Stripe.";

/**
 * Runs `action` with the game locked so two players can't take the same spot, after tidying it up
 * (expired holds, waitlist offers). Redraws the lobby and sends DMs once the change is saved.
 */
async function withGame(matchId: number, action: (tx: Tx, match: Match, fx: Effects) => Promise<Result>): Promise<Result> {
  const fx: Effects = { changed: false, offers: [] };
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
  const lapsed = await tx`
    UPDATE registrations SET status = 'CANCELLED', hold_expires_at = NULL, left_at = ${new Date()}
    WHERE match_id = ${match.match_id} AND status = 'PENDING' AND hold_expires_at <= ${new Date()}
    RETURNING id`;
  if (lapsed.length) fx.changed = true;
  await offerFreeSpots(tx, match, fx);
}

async function offerFreeSpots(tx: Tx, match: Match, fx: Effects) {
  if (match.status !== "OPEN" || started(match)) return;
  const free = match.max_players - (await takenSpots(tx, match.match_id));
  if (free <= 0) return;
  const offered = await tx<{ discord_user_id: string }[]>`
    UPDATE registrations SET status = 'PENDING', offered_at = ${new Date()}, hold_expires_at = ${minutesFromNow(OFFER_MINUTES)}
    WHERE id IN (SELECT id FROM registrations WHERE match_id = ${match.match_id} AND status = 'WAITLIST' ORDER BY created_at LIMIT ${free})
    RETURNING discord_user_id`;
  if (offered.length) fx.changed = true;
  fx.offers.push(...offered.map((r) => r.discord_user_id));
}

async function takenSpots(tx: Tx, matchId: number): Promise<number> {
  const [{ n }] = await tx<{ n: number }[]>`
    SELECT count(*)::int AS n FROM registrations WHERE match_id = ${matchId} AND status IN ('CONFIRMED', 'PENDING')`;
  return n;
}

async function registrationOf(tx: Tx, matchId: number, userId: string) {
  const [reg] = await tx<(Registration & { id: number })[]>`
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

async function paidSoFar(tx: Tx, matchId: number, userId: string): Promise<number> {
  const [{ cents }] = await tx<{ cents: number }[]>`
    SELECT coalesce(sum(CASE WHEN kind = 'PAYMENT' THEN amount_cents ELSE -amount_cents END), 0)::int AS cents
    FROM payments WHERE match_id = ${matchId} AND discord_user_id = ${userId}`;
  return cents;
}

function cancelledText(match: Match): string {
  return `❌ This game was cancelled${match.cancel_reason ? ` (${match.cancel_reason})` : ""}. Everyone who paid was refunded in full.`;
}

function closedText(match: Match): string {
  if (match.status === "CANCELLED") return cancelledText(match);
  if (match.status === "DRAFT") return "This game isn't open yet.";
  return "This game has started, so the roster is closed.";
}

function payPrompt(match: Match, holdUntil: Date | string, offered: boolean): Result {
  return {
    content: [
      offered
        ? `🎉 **A spot opened up for you** in ${title(match)}, ${torontoLabel(new Date(match.kickoff_time))}.`
        : `⏳ **Spot held for you** in ${title(match)}, ${torontoLabel(new Date(match.kickoff_time))}.`,
      `Pay by <t:${unix(holdUntil)}:t> (<t:${unix(holdUntil)}:R>) to lock it in, or it goes to the next person.`,
      testNote,
    ].join("\n"),
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: `Pay ${money(match.checkout_price_cents)} (test)`, custom_id: `pay:${match.match_id}` },
          { type: 2, style: 2, label: offered ? "No thanks" : "Cancel", custom_id: `drop:${match.match_id}` },
        ],
      },
    ],
  };
}

/** Claim & Pay on the lobby: hold a spot, or join the waitlist when the game is full. */
export function claim(matchId: number, player: Player): Promise<Result> {
  return withGame(matchId, async (tx, match, fx) => {
    if (match.status !== "OPEN" || started(match)) return { content: closedText(match) };
    const reg = await registrationOf(tx, matchId, player.id);
    if (reg?.status === "CONFIRMED") return { content: "✅ You're already in this game." };
    if (reg?.status === "PENDING") return payPrompt(match, reg.hold_expires_at!, !!reg.offered_at);
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
        created_at = EXCLUDED.created_at, offered_at = NULL, paid_at = NULL, left_at = NULL`;
    fx.changed = true;
    if (!full) return payPrompt(match, holdUntil!, false);
    return {
      content: `📋 The game is full. You're **#${await waitlistPosition(tx, matchId, player.id)} on the waitlist**. If a spot opens I'll DM you and hold it for ${OFFER_MINUTES} minutes.`,
    };
  });
}

/** Pay on a held spot. A test payment for now; Stripe Checkout replaces this. */
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

    const amount = match.checkout_price_cents;
    await tx`
      INSERT INTO payments (match_id, discord_user_id, kind, amount_cents, provider, reference)
      VALUES (${matchId}, ${player.id}, 'PAYMENT', ${amount}, 'MOCK', ${`mock_${randomUUID()}`})`;
    await tx`
      UPDATE registrations SET status = 'CONFIRMED', hold_expires_at = NULL, paid_at = ${new Date()}
      WHERE match_id = ${matchId} AND discord_user_id = ${player.id}`;
    fx.changed = true;
    return {
      content: [
        `✅ **You're in!** ${title(match)}, ${torontoLabel(new Date(match.kickoff_time))}.`,
        `Paid ${money(amount)}. Need to drop out? Press **Leave Match** on the game up to ${LEAVE_CUTOFF_HOURS} hours before kickoff.`,
        testNote,
      ].join("\n"),
      components: [],
    };
  });
}

/** Leave Match, Cancel or No thanks. Paid players are asked to confirm first (see leaveConfirmed). */
export function leave(matchId: number, player: Player): Promise<Result> {
  return withGame(matchId, async (tx, match, fx) => {
    if (match.status === "CANCELLED") return { content: cancelledText(match), components: [] };
    const reg = await registrationOf(tx, matchId, player.id);
    if (!reg || reg.status === "CANCELLED") return { content: "You're not on this game's roster.", components: [] };

    if (reg.status === "WAITLIST" || reg.status === "PENDING") {
      await tx`
        UPDATE registrations SET status = 'CANCELLED', hold_expires_at = NULL, left_at = ${new Date()}
        WHERE match_id = ${matchId} AND discord_user_id = ${player.id}`;
      fx.changed = true;
      await offerFreeSpots(tx, match, fx);
      return {
        content: reg.status === "WAITLIST" ? "👋 You're off the waitlist." : "👋 Spot released. You weren't charged.",
        components: [],
      };
    }

    const late = cutoffPassed(match);
    if (late) return { content: late, components: [] };
    const paid = await paidSoFar(tx, matchId, player.id);
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

    const paid = await paidSoFar(tx, matchId, player.id);
    const refund = Math.max(0, paid - cardFeeCents(paid));
    if (refund > 0) {
      await tx`
        INSERT INTO payments (match_id, discord_user_id, kind, amount_cents, provider, reference)
        VALUES (${matchId}, ${player.id}, 'REFUND', ${refund}, 'MOCK', ${`mock_${randomUUID()}`})`;
    }
    await tx`
      UPDATE registrations SET status = 'CANCELLED', paid_at = NULL, left_at = ${new Date()}
      WHERE match_id = ${matchId} AND discord_user_id = ${player.id}`;
    fx.changed = true;
    await offerFreeSpots(tx, match, fx);
    return {
      content: [`👋 You've left Match #${matchId}. Refund: **${money(refund)}** (your ${money(paid)} minus the ${money(paid - refund)} card fee).`, testNote].join(
        "\n",
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
      OR EXISTS (SELECT 1 FROM registrations r WHERE r.match_id = m.match_id AND r.status = 'PENDING' AND r.hold_expires_at <= ${new Date()})
      OR (EXISTS (SELECT 1 FROM registrations r WHERE r.match_id = m.match_id AND r.status = 'WAITLIST')
          AND (SELECT count(*) FROM registrations r WHERE r.match_id = m.match_id AND r.status IN ('CONFIRMED', 'PENDING')) < m.max_players)
    )`;
  for (const { match_id } of due) {
    await withGame(match_id, async (tx, match, fx) => {
      if (match.status === "OPEN" && started(match)) {
        await tx`UPDATE matches SET status = 'LOCKED' WHERE match_id = ${match_id}`;
        await tx`
          UPDATE registrations SET status = 'CANCELLED', hold_expires_at = NULL, left_at = ${new Date()}
          WHERE match_id = ${match_id} AND status = 'PENDING'`;
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
  if (!fx.changed && !fx.offers.length) return;
  const [match] = await sql<Match[]>`SELECT * FROM matches WHERE match_id = ${before.match_id}`;
  if (fx.changed && match.channel_id && match.message_id) {
    await discord("PATCH", `/channels/${match.channel_id}/messages/${match.message_id}`, lobbyMessage(match, await rosterOf(match.match_id))).catch(
      (err) => console.error("Couldn't redraw the lobby", err),
    );
  }
  for (const userId of fx.offers) await offerSpot(match, userId);
}

async function offerSpot(match: Match, userId: string) {
  const [reg] = await sql<Registration[]>`
    SELECT * FROM registrations WHERE match_id = ${match.match_id} AND discord_user_id = ${userId}`;
  try {
    const dm = await discord<{ id: string }>("POST", "/users/@me/channels", { recipient_id: userId });
    await discord("POST", `/channels/${dm.id}/messages`, payPrompt(match, reg.hold_expires_at!, true));
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
    testNote,
  ].join("\n");
}

/** What cancelling would do, for the organizer's "are you sure?" prompt. */
export async function cancelPreview(matchId: number): Promise<{ match: Match; paidPlayers: number; refundCents: number; others: number } | null> {
  const [match] = await sql<Match[]>`SELECT * FROM matches WHERE match_id = ${matchId}`;
  if (!match) return null;
  const [row] = await sql<{ paid_players: number; refund: number; others: number }[]>`
    SELECT
      (SELECT count(*)::int FROM registrations WHERE match_id = ${matchId} AND status = 'CONFIRMED') AS paid_players,
      (SELECT coalesce(sum(CASE WHEN p.kind = 'PAYMENT' THEN p.amount_cents ELSE -p.amount_cents END), 0)::int
         FROM payments p JOIN registrations r ON r.match_id = p.match_id AND r.discord_user_id = p.discord_user_id
         WHERE p.match_id = ${matchId} AND r.status <> 'CANCELLED') AS refund, -- players who already left keep their earlier refund
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

    affected = await tx<Affected[]>`
      SELECT r.discord_user_id, r.status,
             coalesce((SELECT sum(CASE WHEN p.kind = 'PAYMENT' THEN p.amount_cents ELSE -p.amount_cents END)
                       FROM payments p WHERE p.match_id = r.match_id AND p.discord_user_id = r.discord_user_id), 0)::int AS refund
      FROM registrations r WHERE r.match_id = ${matchId} AND r.status <> 'CANCELLED'`;
    for (const a of affected.filter((a) => a.refund > 0)) {
      await tx`
        INSERT INTO payments (match_id, discord_user_id, kind, amount_cents, provider, reference)
        VALUES (${matchId}, ${a.discord_user_id}, 'REFUND', ${a.refund}, 'MOCK', ${`mock_${randomUUID()}`})`;
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
        ? `You've been refunded **${money(a.refund)}** in full.\n${testNote}`
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
    paid.length ? `Refunded ${paid.length} player${paid.length === 1 ? "" : "s"} ${money(total)} in total (test mode, no real money moved).` : "No one had paid yet.",
    affected.length ? `Told ${affected.length} player${affected.length === 1 ? "" : "s"}: ${dmed} by DM${unreachable.length ? `, ${unreachable.length} mentioned in #games` : ""}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
