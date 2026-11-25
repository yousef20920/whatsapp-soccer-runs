import { hostReady, payoutsRedirect, userFromToken } from "../lib/payouts.js";

// The link in /payouts. Makes a fresh one-time Stripe link (they expire within minutes) and sends the host
// there: Stripe's onboarding until they're set up, then their Stripe payouts page. Stripe sends them back
// here with done=1 when they finish or leave.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("t") ?? "";
  const userId = userFromToken(token);
  if (!userId) return page("⌛", "This link has expired", "Run /payouts in Discord for a new one.");

  if (url.searchParams.has("done")) {
    return (await hostReady(userId))
      ? page("✅", "Payouts are on", "After each game you host, players' payments go to your bank. You can close this tab.")
      : page("⏳", "Not finished yet", "Stripe still needs a few details. Open the link from /payouts again to pick up where you left off.");
  }
  try {
    const next = await payoutsRedirect(userId, token);
    if ("url" in next) return Response.redirect(next.url, 303);
    return page("❓", "Start in Discord", "Run /payouts in Discord first, then open its link.");
  } catch (err) {
    console.error("Couldn't open Stripe for payouts", err);
    return page("⚠️", "Something went wrong", "Please try again in a minute.");
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function page(icon: string, heading: string, text: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NasorAI payouts</title><style>
:root{--bg:#f6f7fb;--card:#fff;--text:#1d2130;--muted:#5b6275;--line:#e3e6ef}
@media (prefers-color-scheme:dark){:root{--bg:#15171e;--card:#1e212b;--text:#e8eaf2;--muted:#a2a8ba;--line:#2d313e}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:480px;margin:12vh auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;text-align:center}
.icon{font-size:44px}h1{font-size:24px;margin:8px 0}p{color:var(--muted);margin:0}
</style></head><body><main><div class="card"><div class="icon">${icon}</div><h1>${esc(heading)}</h1><p>${esc(text)}</p></div></main></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
