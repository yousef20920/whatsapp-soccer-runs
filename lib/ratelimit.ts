import { sql } from "./db.js";

// Each person gets LIMIT commands or button presses per WINDOW_SECONDS. Plenty for normal use
// (joining, paying, voting), but stops one account from hammering the bot.
const WINDOW_SECONDS = 30;
const LIMIT = 10;

/** Counts this action and returns true if the person is over the limit. Never blocks on a database error. */
export async function tooFast(discordUserId: string): Promise<boolean> {
  const window = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
  try {
    const [row] = await sql<{ hits: number }[]>`
      INSERT INTO rate_limits (discord_user_id, window_start, hits) VALUES (${discordUserId}, ${window}, 1)
      ON CONFLICT (discord_user_id) DO UPDATE SET
        hits = CASE WHEN rate_limits.window_start = EXCLUDED.window_start THEN rate_limits.hits + 1 ELSE 1 END,
        window_start = EXCLUDED.window_start
      RETURNING hits`;
    return row.hits > LIMIT;
  } catch (err) {
    console.error("Rate limit check failed", err);
    return false;
  }
}
