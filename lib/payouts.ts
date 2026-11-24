import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "./db.js";
import { botLog, displayName, EPHEMERAL, isOrganizer, sendDirectMessage, type Interaction } from "./discord.js";
import { money } from "./pricing.js";
import { chargeOf, createHostAccount, hostAccountLink, hostCanReceive, SITE_URL, stripeEnabled, stripeTestMode, transferToHost } from "./stripe.js";

// Host payouts: the organizer who reserves a game is its host. Players pay the club through Stripe, and once
// the game kicks off SORY sends each paid spot (minus Stripe's fee) to the host's own Stripe account, which
// pays out to their bank. Hosts set that up once with /payouts.

const LINK_HOURS = 24;

export async function hostAccountOf(discordUserId: string): Promise<string | null> {
  const [row] = await sql<{ stripe_account_id: string }[]>`SELECT stripe_account_id FROM hosts WHERE discord_user_id = ${discordUserId}`;
  return row?.stripe_account_id ?? null;
}

// The /payouts link carries a signed, expiring token instead of the Stripe link itself: Stripe's links
// are single-use and expire within minutes, so SORY makes a fresh one each time it's opened.
function sign(text: string): string {
  return createHmac("sha256", `sory-payouts:${process.env.STRIPE_SECRET_KEY ?? ""}`).update(text).digest("base64url");
}
export function payoutsUrl(discordUserId: string): string {
  const expires = Math.floor(Date.now() / 1000) + LINK_HOURS * 3600;
  return `${SITE_URL}/api/payouts?t=${discordUserId}.${expires}.${sign(`${discordUserId}.${expires}`)}`;
}
export function userFromToken(token: string): string | null {
  const [user, expires, sig] = token.split(".");
  if (!user || !expires || !sig || Number(expires) * 1000 < Date.now()) return null;
  const want = Buffer.from(sign(`${user}.${expires}`));
  const given = Buffer.from(sig);
  return want.length === given.length && timingSafeEqual(want, given) ? user : null;
}

/** /payouts: organizers set up (or check) where their games' money goes. */
export async function payoutsCommand(interaction: Interaction) {
  const reply = (content: string) => ({ content, flags: EPHEMERAL });
  if (!isOrganizer(interaction)) return reply("Only organizers host games, so only they need payouts.");
  if (!stripeEnabled()) return reply("Card payments aren't switched on yet, so there's nothing to pay out.");

  const userId = interaction.member!.user.id;
  let accountId = await hostAccountOf(userId);
  if (!accountId) {
    accountId = (await createHostAccount(displayName(interaction), userId)).id;
    await sql`INSERT INTO hosts (discord_user_id, stripe_account_id) VALUES (${userId}, ${accountId}) ON CONFLICT DO NOTHING`;
    accountId = (await hostAccountOf(userId))!; // someone double-clicked: keep the first account
  }
  const test = stripeTestMode() ? "\n-# Stripe test mode: use Stripe's test details, no real bank needed." : "";
  if (await hostCanReceive(accountId)) {
    return reply(`✅ **Payouts are on.** After each game you host, players' payments (minus card fees) go to your bank.\n[Open your Stripe payouts page](${payoutsUrl(userId)})${test}`);
  }
  return reply(
    [
      `💸 **Get paid for the games you host.** Once this is set up, players' payments go to your bank after each game you host: the field cost plus your host fee.`,
      `**[Set up payouts](${payoutsUrl(userId)})**: about 5 minutes on Stripe's site, which asks for your ID and bank. The link works for ${LINK_HOURS} hours.`,
      `-# Until then, your games' money waits and is sent as soon as you finish.${test}`,
    ].join("\n"),
  );
}

/** Where /api/payouts sends the host: Stripe onboarding, or their dashboard once they're set up. */
export async function payoutsRedirect(discordUserId: string, token: string): Promise<{ url: string } | { ready: boolean }> {
  const accountId = await hostAccountOf(discordUserId);
  if (!accountId) return { ready: false };
  const here = `${SITE_URL}/api/payouts?t=${token}`;
  const ready = await hostCanReceive(accountId);
  return { url: await hostAccountLink(accountId, ready ? "dashboard" : "onboarding", `${here}&done=1`, here) };
}

export async function hostReady(discordUserId: string): Promise<boolean> {
  const accountId = await hostAccountOf(discordUserId);
  return !!accountId && (await hostCanReceive(accountId));
}

/**
 * Runs in the once-a-minute sweep: for games that have kicked off, sends each paid spot to the host.
 * A spot is sent once (Stripe idempotency plus a host_payouts row). Spots whose payment was refunded
 * (the player left, or paid twice) send nothing: the club keeps only what covers Stripe's fee.
 * Hosts who haven't finished /payouts are skipped and caught up once they have.
 */
export async function sendHostPayouts(): Promise<number> {
  if (!stripeEnabled()) return 0;
  const due = await sql<{ payment_id: number; match_id: number; reference: string; host_id: string; stripe_account_id: string }[]>`
    SELECT p.id AS payment_id, p.match_id, p.reference, m.created_by AS host_id, h.stripe_account_id
    FROM payments p
    JOIN matches m ON m.match_id = p.match_id
    JOIN hosts h ON h.discord_user_id = m.created_by
    JOIN registrations r ON r.match_id = p.match_id AND r.discord_user_id = p.discord_user_id
    WHERE p.kind = 'PAYMENT' AND p.provider = 'STRIPE' AND r.status = 'CONFIRMED'
      AND m.status <> 'CANCELLED' AND m.kickoff_time <= ${new Date()}
      AND NOT EXISTS (SELECT 1 FROM host_payouts hp WHERE hp.payment_id = p.id)
    ORDER BY p.id
    LIMIT 50`;
  if (!due.length) return 0;

  const ready = new Map<string, boolean>();
  const sent = new Map<string, { hostId: string; matchId: number; cents: number; spots: number }>();
  for (const p of due) {
    if (!ready.has(p.stripe_account_id)) ready.set(p.stripe_account_id, await hostCanReceive(p.stripe_account_id).catch(() => false));
    if (!ready.get(p.stripe_account_id)) continue;
    try {
      const charge = await chargeOf(p.reference);
      if (charge.fee === null) continue; // Stripe hasn't settled the fee yet: try next minute
      const amount = charge.refunded > 0 ? 0 : charge.amount - charge.fee;
      const transfer = amount > 0
        ? await transferToHost({ accountId: p.stripe_account_id, amountCents: amount, chargeId: charge.id, matchId: p.match_id, paymentId: p.payment_id })
        : null;
      await sql`
        INSERT INTO host_payouts (payment_id, match_id, host_id, amount_cents, transfer_id)
        VALUES (${p.payment_id}, ${p.match_id}, ${p.host_id}, ${transfer ? amount : 0}, ${transfer?.id ?? null})
        ON CONFLICT DO NOTHING`;
      if (transfer) {
        const key = `${p.host_id}:${p.match_id}`;
        const total = sent.get(key) ?? { hostId: p.host_id, matchId: p.match_id, cents: 0, spots: 0 };
        sent.set(key, { ...total, cents: total.cents + amount, spots: total.spots + 1 });
      }
    } catch (err) {
      console.error(`Couldn't pay out payment ${p.payment_id}`, err);
    }
  }
  for (const s of sent.values()) {
    const test = stripeTestMode() ? " (Stripe test)" : "";
    await botLog(`💸 Sent ${money(s.cents)} to <@${s.hostId}> for Match #${s.matchId} (${s.spots} paid spot${s.spots === 1 ? "" : "s"})${test}`);
    await sendDirectMessage(s.hostId, {
      content: `💸 **${money(s.cents)}** from Match #${s.matchId} (${s.spots} paid spot${s.spots === 1 ? "" : "s"}) is on its way to your Stripe account, which pays out to your bank.${test}`,
    });
  }
  return [...sent.values()].reduce((n, s) => n + s.spots, 0);
}

/** For /roster: what's been sent to the host so far, or why not. */
export async function payoutLine(matchId: number, hostId: string, kickoff: Date, paidSpots: number): Promise<string> {
  if (!stripeEnabled() || !paidSpots) return "";
  const [row] = await sql<{ cents: number; spots: number }[]>`
    SELECT coalesce(sum(amount_cents), 0)::int AS cents, count(transfer_id)::int AS spots FROM host_payouts WHERE match_id = ${matchId}`;
  if (row.spots) return `💸 Sent to <@${hostId}>: **${money(row.cents)}** for ${row.spots} paid spot${row.spots === 1 ? "" : "s"}`;
  if (!(await hostReady(hostId))) return `💸 <@${hostId}> hasn't set up payouts yet (\`/payouts\`). The money waits until they do.`;
  return kickoff.getTime() > Date.now() ? `💸 Paid spots go to <@${hostId}> at kickoff.` : `💸 Sending to <@${hostId}> now.`;
}
