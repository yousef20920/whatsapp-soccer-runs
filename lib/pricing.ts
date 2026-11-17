// Stripe's standard Canadian card pricing.
const STRIPE_PERCENT = 0.029;
const STRIPE_FIXED_CENTS = 30;

/**
 * Splits the field cost across the roster and grosses it up so the Stripe fee is covered,
 * rounding up to the next 25 cents for a clean price. Members only ever see checkoutCents.
 */
export function priceFor(fieldCostCents: number, maxPlayers: number) {
  const baseCents = Math.ceil(fieldCostCents / maxPlayers);
  const grossCents = Math.ceil((baseCents + STRIPE_FIXED_CENTS) / (1 - STRIPE_PERCENT));
  const checkoutCents = Math.ceil(grossCents / 25) * 25;
  return { baseCents, checkoutCents };
}

export const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
