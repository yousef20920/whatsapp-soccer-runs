// Minimal Stripe client (Checkout Sessions and refunds) over Stripe's REST API.
// Players pay on Stripe's own hosted Checkout page, so card details never touch SORY.

const API = "https://api.stripe.com/v1";
const key = () => process.env.STRIPE_SECRET_KEY ?? "";

/** Real Stripe payments are on once STRIPE_SECRET_KEY is set; otherwise SORY uses test (mock) payments. */
export const stripeEnabled = () => key().length > 0;
/** Stripe sandbox (test) keys: payments use test cards and no real money moves. */
export const stripeTestMode = () => /^(sk|rk)_test_/.test(key());

export const SITE_URL = process.env.SITE_URL ?? "https://sory-five.vercel.app";

/** Flattens { a: { b: 1 } } into Stripe's form encoding: a[b]=1. */
function form(params: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") form(v as Record<string, unknown>, name, out);
    else out.append(name, String(v));
  }
  return out;
}

async function stripe<T>(method: "GET" | "POST", path: string, params?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
  const body = params && method === "POST" ? form(params) : undefined;
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${key()}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body,
  });
  const data = (await res.json()) as T & { error?: { message?: string; code?: string } };
  if (!res.ok) throw new StripeError(data.error?.message ?? `Stripe ${method} ${path} failed (${res.status})`, data.error?.code);
  return data;
}

export class StripeError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

export interface CheckoutSession {
  id: string;
  url: string | null;
  status: "open" | "complete" | "expired";
  payment_status: "paid" | "unpaid" | "no_payment_required";
  payment_intent: string | null;
  amount_total: number | null;
  metadata: { match_id?: string; discord_user_id?: string };
}

/**
 * A Stripe Checkout page for one player's spot. Stripe needs at least 30 minutes before a session
 * expires on its own; SORY expires it sooner itself when the hold runs out.
 */
export function createCheckout(opts: { matchId: number; userId: string; amountCents: number; description: string; holdKey: string }) {
  return stripe<CheckoutSession>(
    "POST",
    "/checkout/sessions",
    {
      mode: "payment",
      line_items: { 0: { quantity: 1, price_data: { currency: "cad", unit_amount: opts.amountCents, product_data: { name: opts.description } } } },
      client_reference_id: `${opts.matchId}:${opts.userId}`,
      metadata: { match_id: opts.matchId, discord_user_id: opts.userId },
      payment_intent_data: { metadata: { match_id: opts.matchId, discord_user_id: opts.userId } },
      success_url: `${SITE_URL}/api/paid?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/api/paid?session_id={CHECKOUT_SESSION_ID}&cancelled=1`,
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
      adaptive_pricing: { enabled: false }, // always charge in CAD, never a converted local currency
    },
    opts.holdKey,
  );
}

export const getCheckout = (id: string) => stripe<CheckoutSession>("GET", `/checkout/sessions/${encodeURIComponent(id)}`);

/** Closes an unpaid Checkout page so it can't be paid any more. Returns the session as it ends up. */
export async function expireCheckout(id: string): Promise<CheckoutSession> {
  try {
    return await stripe<CheckoutSession>("POST", `/checkout/sessions/${encodeURIComponent(id)}/expire`);
  } catch {
    return getCheckout(id); // already expired, or paid a moment ago
  }
}

export function refund(paymentIntent: string, amountCents: number, idempotencyKey: string) {
  return stripe<{ id: string; status: string }>("POST", "/refunds", { payment_intent: paymentIntent, amount: amountCents }, idempotencyKey);
}
