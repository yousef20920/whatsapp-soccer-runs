import { sql, type Match } from "./db.js";
import { discord, editReply, env, followUpPrivately, option, playerOf, type Interaction } from "./discord.js";
import { addList } from "./lobby.js";
import { money } from "./pricing.js";
import { addDays, dayLabel, resolveDate, torontoLabel, torontoToday } from "./time.js";

// "Who wants to play?" polls. Anyone picks a day; players tap I'm in / Can't make it.
// Once POLL_MIN_PLAYERS are in, organizers are told to book a field. No field, time or price is shown.

export const POLL_MIN_PLAYERS = 12;

interface Poll {
  poll_id: number;
  game_day: string; // YYYY-MM-DD
  status: "OPEN" | "CLOSED";
  channel_id: string;
  message_id: string | null;
  created_by: string;
  ready_at: Date | null;
  match_id: number | null; // the game booked from this poll
}
interface Vote {
  discord_user_id: string;
  answer: "IN" | "OUT";
}

// Read DATE columns as plain "YYYY-MM-DD" text, not a Date at UTC midnight.
const POLL_COLUMNS = sql`poll_id, game_day::text AS game_day, status, channel_id, message_id, created_by, ready_at, match_id`;
const messageLink = (channelId: string | null, messageId: string | null) =>
  `https://discord.com/channels/${env("DISCORD_GUILD_ID")}/${channelId}/${messageId}`;
const pollLink = (p: Poll) => messageLink(p.channel_id, p.message_id);

function pollMessage(poll: Poll, votes: Vote[], gameLink?: string) {
  const ins = votes.filter((v) => v.answer === "IN");
  const outs = votes.filter((v) => v.answer === "OUT");
  const open = poll.status === "OPEN";
  const ready = ins.length >= POLL_MIN_PLAYERS;
  const day = dayLabel(poll.game_day);

  const description = gameLink
    ? `⚽ **Game on!** [Claim your spot here](${gameLink}). Everyone who said I'm in got a DM.`
    : !open
    ? "This poll is closed."
    : ready
      ? `✅ **Enough players!** Organizers will book a field and post the game in #games. Still tap **I'm in** if you want to play.`
      : `Tap **I'm in** if you'd play. Once **${POLL_MIN_PLAYERS}** people are in, organizers book a field and post the game here with the price.`;
  const fields: { name: string; value: string }[] = [];
  addList(fields, `In: ${ins.length}/${POLL_MIN_PLAYERS}`, ins.map((v, i) => `${i + 1}. <@${v.discord_user_id}>`), "No one yet.");
  if (outs.length) fields.push({ name: "Can't make it", value: String(outs.length) });

  return {
    embeds: [
      {
        title: `🗳️ Who wants to play ${day}?`,
        description,
        color: !open ? 0x95a5a6 : ready ? 0x2ecc71 : 0x5865f2,
        fields,
        footer: { text: `Poll #${poll.poll_id} · ${open ? "Change your answer any time" : "Closed"}` },
      },
    ],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 3, label: "I'm in", custom_id: `poll-in:${poll.poll_id}`, disabled: !open },
          { type: 2, style: 2, label: "Can't make it", custom_id: `poll-out:${poll.poll_id}`, disabled: !open },
        ],
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

const votesOf = (pollId: number) =>
  sql<Vote[]>`SELECT discord_user_id, answer FROM poll_votes WHERE poll_id = ${pollId} ORDER BY voted_at`;

/** /poll day: posts the poll in #games (one open poll per day). Anyone can run it. Runs after a private deferred reply. */
export async function startPoll(interaction: Interaction): Promise<void> {
  const reply = (content: string) => editReply(interaction, { content, allowed_mentions: { parse: [] } });
  const today = torontoToday();
  const first = addDays(today, 1);
  const last = addDays(today, 30);
  const day = resolveDate(option<string>(interaction, "day") ?? "", first, last);
  if (!day || day < first || day > last) return void (await reply(`Pick a day from the list (${dayLabel(first)} to ${dayLabel(last)}).`));

  const [existing] = await sql<Poll[]>`SELECT ${POLL_COLUMNS} FROM polls WHERE game_day = ${day} AND status = 'OPEN'`;
  if (existing?.message_id) return void (await reply(`There's already a poll for ${dayLabel(day)}: ${pollLink(existing)}`));

  const player = playerOf(interaction);
  const channelId = env("GAMES_CHANNEL_ID");
  const [poll] = await sql<Poll[]>`
    INSERT INTO polls (game_day, channel_id, created_by) VALUES (${day}, ${channelId}, ${player.id})
    ON CONFLICT DO NOTHING RETURNING ${POLL_COLUMNS}`;
  if (!poll) return void (await reply(`Someone just started a poll for ${dayLabel(day)}. Check #games.`));

  try {
    // Whoever starts the poll wants to play, so count them in.
    await sql`INSERT INTO poll_votes (poll_id, discord_user_id, discord_username, answer) VALUES (${poll.poll_id}, ${player.id}, ${player.name}, 'IN')`;
    const message = await discord<{ id: string }>("POST", `/channels/${channelId}/messages`, pollMessage(poll, await votesOf(poll.poll_id)));
    await sql`UPDATE polls SET message_id = ${message.id} WHERE poll_id = ${poll.poll_id}`;
    await reply(`✅ Poll for ${dayLabel(day)} posted: ${pollLink({ ...poll, message_id: message.id })}`);
  } catch (err) {
    await sql`DELETE FROM polls WHERE poll_id = ${poll.poll_id}`;
    throw err;
  }
}

/**
 * I'm in / Can't make it. Answers after a deferred update, so editing the reply redraws the poll card.
 * The poll row stays locked while the card is redrawn, so quick votes can't overwrite each other's counts.
 */
export async function vote(interaction: Interaction, pollId: number, answer: "IN" | "OUT"): Promise<void> {
  const player = playerOf(interaction);
  let reachedGoal: Poll | null = null;
  const closed = await sql.begin(async (tx) => {
    const [poll] = await tx<Poll[]>`SELECT ${POLL_COLUMNS} FROM polls WHERE poll_id = ${pollId} FOR UPDATE`;
    if (!poll || poll.status !== "OPEN") return true;
    await tx`
      INSERT INTO poll_votes (poll_id, discord_user_id, discord_username, answer) VALUES (${pollId}, ${player.id}, ${player.name}, ${answer})
      ON CONFLICT (poll_id, discord_user_id) DO UPDATE SET answer = EXCLUDED.answer, discord_username = EXCLUDED.discord_username,
        voted_at = CASE WHEN poll_votes.answer = EXCLUDED.answer THEN poll_votes.voted_at ELSE now() END`;
    const votes = await tx<Vote[]>`SELECT discord_user_id, answer FROM poll_votes WHERE poll_id = ${pollId} ORDER BY voted_at`;
    if (!poll.ready_at && votes.filter((v) => v.answer === "IN").length >= POLL_MIN_PLAYERS) {
      await tx`UPDATE polls SET ready_at = now() WHERE poll_id = ${pollId}`;
      reachedGoal = poll;
    }
    await editReply(interaction, pollMessage(poll, votes));
    return false;
  });
  if (closed) return void (await followUpPrivately(interaction, "This poll is closed."));
  if (reachedGoal) await tellOrganizers(reachedGoal);
}

async function tellOrganizers(poll: Poll) {
  const ymd = poll.game_day;
  await discord("POST", `/channels/${env("ORGANIZERS_CHANNEL_ID")}/messages`, {
    content: [
      `✅ **${POLL_MIN_PLAYERS} players are in for ${dayLabel(ymd)}.** Time to book a field.`,
      `Find one with \`/available from:${ymd} to:${ymd}\`, then Reserve it. [See the poll](${pollLink(poll)})`,
    ].join("\n"),
    allowed_mentions: { parse: [] },
  });
}

/** Closes polls once their day arrives (too late to book online). Called by the once-a-minute sweep. */
export async function closeOldPolls(): Promise<number> {
  const closed = await sql<Poll[]>`
    UPDATE polls SET status = 'CLOSED' WHERE status = 'OPEN' AND game_day <= ${torontoToday()}
    RETURNING ${POLL_COLUMNS}`;
  for (const poll of closed) {
    if (!poll.message_id) continue;
    await discord("PATCH", `/channels/${poll.channel_id}/messages/${poll.message_id}`, pollMessage(poll, await votesOf(poll.poll_id))).catch((err) =>
      console.error(`Couldn't close Poll #${poll.poll_id}`, err),
    );
  }
  return closed.length;
}

/** The open poll for a day (YYYY-MM-DD) and who said I'm in, or null if there isn't one. */
export async function pollForDay(ymd: string): Promise<{ poll: Poll; voterIds: string[] } | null> {
  const [poll] = await sql<Poll[]>`SELECT ${POLL_COLUMNS} FROM polls WHERE game_day = ${ymd} AND status = 'OPEN'`;
  if (!poll) return null;
  const voterIds = (await votesOf(poll.poll_id)).filter((v) => v.answer === "IN").map((v) => v.discord_user_id);
  return { poll, voterIds };
}

/**
 * After /confirm posts a game on a poll's day: closes the poll with a link to the game and DMs every
 * "I'm in" voter a Claim & Pay button (no priority: spots stay first come, first served). Voters with DMs off are mentioned in #games.
 * Returns how many were DMed.
 */
export async function invitePollVoters(poll: Poll, match: Match, voterIds: string[]): Promise<number> {
  const gameLink = messageLink(match.channel_id, match.message_id);
  const [closed] = await sql<Poll[]>`
    UPDATE polls SET status = 'CLOSED', match_id = ${match.match_id} WHERE poll_id = ${poll.poll_id} RETURNING ${POLL_COLUMNS}`;
  if (closed.message_id) {
    await discord("PATCH", `/channels/${closed.channel_id}/messages/${closed.message_id}`, pollMessage(closed, await votesOf(poll.poll_id), gameLink)).catch(
      (err) => console.error(`Couldn't update Poll #${poll.poll_id}`, err),
    );
  }
  if (!voterIds.length) return 0;

  const price = money(match.checkout_price_cents);
  const invite = {
    content: [
      `⚽ **Game on for ${dayLabel(poll.game_day)}!** You said you're in on the poll, so here it is.`,
      `📍 ${match.facility_name} · ${match.court_name}`,
      `🕐 ${torontoLabel(new Date(match.kickoff_time))} · ${match.duration_minutes} min · 💵 ${price}`,
      `Spots are first come, first served. [See the game](${gameLink})`,
    ].join("\n"),
    components: [{ type: 1, components: [{ type: 2, style: 3, label: `Claim & Pay (${price})`, custom_id: `claim:${match.match_id}` }] }],
    allowed_mentions: { parse: [] },
  };

  const unreachable: string[] = [];
  let dmed = 0;
  for (const userId of voterIds) {
    try {
      const dm = await discord<{ id: string }>("POST", "/users/@me/channels", { recipient_id: userId });
      await discord("POST", `/channels/${dm.id}/messages`, invite);
      dmed++;
    } catch {
      unreachable.push(userId);
    }
  }
  if (unreachable.length) {
    await discord("POST", `/channels/${match.channel_id}/messages`, {
      content: `${unreachable.map((id) => `<@${id}>`).join(" ")} the game you voted for is up. Spots are first come, first served: ${gameLink}`,
      allowed_mentions: { users: unreachable.slice(0, 100) },
    }).catch((err) => console.error("Couldn't mention poll voters", err));
  }
  return dmed;
}
