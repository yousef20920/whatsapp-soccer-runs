// Stripe's standard Canadian card pricing.
const STRIPE_PERCENT = 0.029;
const STRIPE_FIXED_CENTS = 30;

/** What Stripe keeps from a card payment of this size. */
export const stripeFeeCents = (chargedCents: number) => Math.round(chargedCents * STRIPE_PERCENT) + STRIPE_FIXED_CENTS;

/**
 * Splits the field cost across the roster, grosses it up so the Stripe fee is covered, then rounds up
 * to the next whole dollar. What the rounding adds (after Stripe's cut of it) is the host fee, which goes
 * to the organizer who set up the game. Players only ever see checkoutCents; fees are for organizers' eyes.
 */
export function priceFor(fieldCostCents: number, maxPlayers: number) {
  const baseCents = Math.ceil(fieldCostCents / maxPlayers);
  const grossCents = Math.ceil((baseCents + STRIPE_FIXED_CENTS) / (1 - STRIPE_PERCENT));
  const checkoutCents = Math.ceil(grossCents / 100) * 100;
  return { baseCents, checkoutCents, ...feesFor(baseCents, checkoutCents) };
}

/** Splits one player's price into the field share, Stripe's fee and the host fee. */
export function feesFor(baseCents: number, checkoutCents: number) {
  const stripeCents = stripeFeeCents(checkoutCents);
  return { stripeCents, hostFeeCents: Math.max(0, checkoutCents - stripeCents - baseCents) };
}

/** Players can leave (and get refunded) up to this many hours before kickoff. */
export const LEAVE_CUTOFF_HOURS = 2;

/**
 * Cancellation fee kept when a player leaves a game they paid for. It matches what Stripe keeps on a
 * refunded payment (2.9% + 30¢), so a player leaving never costs the club money.
 */
export function cancellationFeeCents(paidCents: number): number {
  return paidCents > 0 ? stripeFeeCents(paidCents) : 0;
}

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
