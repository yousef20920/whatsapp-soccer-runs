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

// ---- Host payouts (Stripe Connect) ----
// Each host gets a connected account (Accounts v2, recipient configuration, Express dashboard). The club
// stays the merchant: players pay the club, and after kickoff SORY transfers each payment to the host
// (separate charges and transfers), keeping back only what Stripe charged for the payment.

const API_V2 = "https://api.stripe.com/v2";
const V2_VERSION = "2026-10-28.endive";

async function stripeV2<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await fetch(API_V2 + path, {
    method,
    headers: { Authorization: `Bearer ${key()}`, "Stripe-Version": V2_VERSION, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as T & { error?: { message?: string; code?: string } };
  if (!res.ok) throw new StripeError(data.error?.message ?? `Stripe ${method} ${path} failed (${res.status})`, data.error?.code);
  return data;
}

interface HostAccount {
  id: string;
  configuration?: { recipient?: { capabilities?: { stripe_balance?: { stripe_transfers?: { status?: string } } } } };
}

/** A new connected account for a host. Stripe's own onboarding collects their ID and bank. */
export function createHostAccount(displayName: string, email: string, discordUserId: string) {
  return stripeV2<HostAccount>("POST", "/core/accounts", {
    display_name: displayName.slice(0, 100),
    contact_email: email,
    dashboard: "express",
    identity: { country: "ca" },
    defaults: { responsibilities: { fees_collector: "application", losses_collector: "application" } },
    configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
    metadata: { discord_user_id: discordUserId },
    include: ["configuration.recipient"],
  });
}

/** True once the host finished onboarding and can receive transfers. */
export async function hostCanReceive(accountId: string): Promise<boolean> {
  const account = await stripeV2<HostAccount>("GET", `/core/accounts/${encodeURIComponent(accountId)}?include=configuration.recipient`);
  return account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status === "active";
}

/** A one-time link to Stripe's onboarding (or, once set up, to the host's Express dashboard). */
export async function hostAccountLink(accountId: string, kind: "onboarding" | "dashboard", returnUrl: string, refreshUrl: string): Promise<string> {
  const use_case =
    kind === "onboarding"
      ? { type: "account_onboarding", account_onboarding: { return_url: returnUrl, refresh_url: refreshUrl } }
      : { type: "account_dashboard", account_dashboard: { refresh_url: refreshUrl } };
  const link = await stripeV2<{ url: string }>("POST", "/core/account_links", { account: accountId, use_case });
  return link.url;
}

/** The charge behind a player's payment: how much was charged, refunded, and what Stripe kept. */
export async function chargeOf(paymentIntent: string) {
  const pi = await stripe<{
    latest_charge: { id: string; amount: number; amount_refunded: number; balance_transaction: { fee: number } | null } | null;
  }>("GET", `/payment_intents/${encodeURIComponent(paymentIntent)}?expand[]=latest_charge.balance_transaction`);
  const charge = pi.latest_charge;
  if (!charge) throw new StripeError(`No charge on ${paymentIntent}`);
  return { id: charge.id, amount: charge.amount, refunded: charge.amount_refunded, fee: charge.balance_transaction?.fee ?? null };
}

/** Sends part of a player's payment to the host. Tied to the charge so it can go out before the funds settle. */
export function transferToHost(opts: { accountId: string; amountCents: number; chargeId: string; matchId: number; paymentId: number }) {
  return stripe<{ id: string }>(
    "POST",
    "/transfers",
    {
      amount: opts.amountCents,
      currency: "cad",
      destination: opts.accountId,
      source_transaction: opts.chargeId,
      transfer_group: `match-${opts.matchId}`,
      metadata: { match_id: opts.matchId, payment_id: opts.paymentId },
    },
    `host-payout-${opts.paymentId}`,
  );
}
