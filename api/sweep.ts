import { timingSafeEqual } from "node:crypto";
import { json } from "../lib/discord.js";
import { sweep } from "../lib/roster.js";

// Called once a minute by a Supabase pg_cron job (scripts/schedule-sweep.mjs): releases unpaid holds,
// offers free spots to the waitlist and closes games at kickoff.
export async function POST(request: Request): Promise<Response> {
  const expected = Buffer.from(`Bearer ${process.env.SWEEP_SECRET ?? ""}`);
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  if (!process.env.SWEEP_SECRET || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return json({ games: await sweep() });
}
