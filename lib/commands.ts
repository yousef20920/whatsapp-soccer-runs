import { sql, type Match, type Registration } from "./db.js";
import { discord, displayName, editReply, EPHEMERAL, env, isOrganizer, option, type Interaction } from "./discord.js";
import { lobbyMessage } from "./lobby.js";
import { money, priceFor } from "./pricing.js";
import { parseDate, parseTime, torontoLabel, torontoToDate } from "./time.js";

type Reply = { content: string; flags?: number };

const DEFAULT_MAX_PLAYERS = 18;
const DEFAULT_DURATION_MINUTES = 60;

/** /newgame: creates a DRAFT match. Players can't see or pay for it until /confirm. */
export async function newGame(interaction: Interaction): Promise<Reply> {
  if (!isOrganizer(interaction)) return privateReply("Only organizers can create games.");

  const facility = option<string>(interaction, "facility")!.trim();
  const court = option<string>(interaction, "court")!.trim();
  const date = parseDate(option<string>(interaction, "date")!);
  const time = parseTime(option<string>(interaction, "time")!);
  const fieldCost = option<number>(interaction, "field_cost")!;
  const maxPlayers = option<number>(interaction, "max_players") ?? DEFAULT_MAX_PLAYERS;
  const duration = option<number>(interaction, "duration") ?? DEFAULT_DURATION_MINUTES;

  if (!date) return privateReply("I couldn't read that date. Use YYYY-MM-DD, like 2026-11-21.");
  if (!time) return privateReply("I couldn't read that time. Use something like 20:00 or 8pm.");
  const kickoff = torontoToDate(date, time);
  if (kickoff.getTime() <= Date.now()) return privateReply("That kickoff time has already passed.");

  const fieldCostCents = Math.round(fieldCost * 100);
  const { baseCents, checkoutCents } = priceFor(fieldCostCents, maxPlayers);

  const [match] = await sql<Match[]>`
    INSERT INTO matches (facility_name, court_name, kickoff_time, duration_minutes, max_players,
                         field_cost_cents, base_price_cents, checkout_price_cents, created_by)
    VALUES (${facility}, ${court}, ${kickoff}, ${duration}, ${maxPlayers},
            ${fieldCostCents}, ${baseCents}, ${checkoutCents}, ${interaction.member!.user.id})
    RETURNING *`;

  return privateReply(
    [
      `📝 **Draft Match #${match.match_id}** created (players can't see it yet).`,
      `**${facility} · ${court}**, ${torontoLabel(kickoff)}, ${duration} min, ${maxPlayers} players`,
      `Field ${money(fieldCostCents)} → ${money(baseCents)} each + card fee = **${money(checkoutCents)} per player**`,
      `Once the field is booked, run \`/confirm match:${match.match_id}\` to post it in #games.`,
    ].join("\n"),
  );
}

/** /confirm: DRAFT -> OPEN and posts the Match Lobby in #games. Runs after a deferred reply. */
export async function confirmMatch(interaction: Interaction): Promise<void> {
  const reply = (content: string) => editReply(interaction, { content });
  if (!isOrganizer(interaction)) return void (await reply("Only organizers can confirm games."));

  const matchId = option<number>(interaction, "match")!;
  const [match] = await sql<Match[]>`SELECT * FROM matches WHERE match_id = ${matchId}`;
  if (!match) return void (await reply(`There's no Match #${matchId}.`));
  if (match.status !== "DRAFT") return void (await reply(`Match #${matchId} is already ${match.status.toLowerCase()}.`));
  if (new Date(match.kickoff_time).getTime() <= Date.now()) return void (await reply(`Match #${matchId} has already started.`));

  const opened: Match = { ...match, status: "OPEN" };
  const registrations = await sql<Registration[]>`
    SELECT discord_user_id, discord_username, status FROM registrations
    WHERE match_id = ${matchId} ORDER BY created_at`;
  const channelId = env("GAMES_CHANNEL_ID");
  const message = await discord<{ id: string }>("POST", `/channels/${channelId}/messages`, lobbyMessage(opened, registrations));

  await sql`
    UPDATE matches SET status = 'OPEN', channel_id = ${channelId}, message_id = ${message.id}
    WHERE match_id = ${matchId}`;
  await reply(`✅ Match #${matchId} is open and posted in <#${channelId}>.`);
}

/** Claim & Pay / Leave Match buttons. Payments arrive in the next build step. */
export function lobbyButton(interaction: Interaction): Reply {
  const [action] = (interaction.data?.custom_id ?? "").split(":");
  const name = displayName(interaction);
  if (action === "claim") return privateReply(`Thanks ${name}! Payments aren't switched on yet. They're coming in the next update.`);
  if (action === "leave") return privateReply("You're not on this game's roster.");
  return privateReply("That button isn't recognized.");
}

function privateReply(content: string): Reply {
  return { content, flags: EPHEMERAL };
}
