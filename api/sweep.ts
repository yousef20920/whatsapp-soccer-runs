import { timingSafeEqual } from "node:crypto";
import { clearTypedMessages, json } from "../lib/discord.js";
import { closeOldPolls } from "../lib/polls.js";
import { sweep } from "../lib/roster.js";

// Called once a minute by a Supabase pg_cron job (scripts/schedule-sweep.mjs): releases unpaid holds,
// offers free spots to the waitlist, closes games at kickoff, closes polls on their day and keeps #plan-a-run commands-only.
export async function POST(request: Request): Promise<Response> {
  const expected = Buffer.from(`Bearer ${process.env.SWEEP_SECRET ?? ""}`);
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  if (!process.env.SWEEP_SECRET || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const typedMessagesRemoved = await clearTypedMessages().catch((err) => (console.error("Couldn't tidy #plan-a-run", err), 0));
  return json({ games: await sweep(), pollsClosed: await closeOldPolls(), typedMessagesRemoved });
}
