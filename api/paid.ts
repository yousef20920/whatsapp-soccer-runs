import { settleCheckout } from "../lib/roster.js";
import { torontoLabel } from "../lib/time.js";

// Stripe sends players here after Checkout (paid or cancelled). NasorAI checks the payment with Stripe itself,
// so this page can't be faked by editing the link.
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id") ?? "";
  const cancelled = url.searchParams.has("cancelled");
  const { state, match } = sessionId.startsWith("cs_") ? await settleCheckout(sessionId) : { state: "unknown" as const, match: undefined };
  const game = match ? `${match.facility_name} · ${match.court_name}, ${torontoLabel(new Date(match.kickoff_time))}` : "";

  const [icon, heading, text] =
    state === "paid"
      ? ["✅", "You're in!", `Your spot is confirmed: ${game}. You'll get a DM from NasorAI too. You can close this tab.`]
      : state === "refunded"
        ? ["↩️", "Payment refunded", `Your payment came in after the spot was gone, so it was refunded in full. Check Discord for other games.`]
        : cancelled || state === "unpaid"
          ? ["⏳", "Not paid", `No payment was taken. If your hold hasn't run out, go back to Discord and press Pay again.`]
          : ["❓", "Payment not found", `Go back to Discord and press Claim & Pay on the game to try again.`];
  return new Response(page(icon, heading, text), { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function page(icon: string, heading: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NasorAI payment</title><style>
:root{--bg:#f6f7fb;--card:#fff;--text:#1d2130;--muted:#5b6275;--line:#e3e6ef}
@media (prefers-color-scheme:dark){:root{--bg:#15171e;--card:#1e212b;--text:#e8eaf2;--muted:#a2a8ba;--line:#2d313e}}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:480px;margin:12vh auto;padding:0 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px;text-align:center}
.icon{font-size:44px}h1{font-size:24px;margin:8px 0}p{color:var(--muted);margin:0}
</style></head><body><main><div class="card"><div class="icon">${icon}</div><h1>${esc(heading)}</h1><p>${esc(text)}</p></div></main></body></html>`;
}
