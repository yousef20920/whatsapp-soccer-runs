import { createHash } from "node:crypto";
import { sql, type Match } from "./db.js";
import { botLog, deleteReply, discord, displayName, editReply, EPHEMERAL, env, isOrganizer, option, type Interaction } from "./discord.js";
import { lobbyMessage } from "./lobby.js";
import { cancelPreview, rosterOf, rosterReport } from "./roster.js";
import { invitePollVoters, pollForDay } from "./polls.js";
import { money, priceFor } from "./pricing.js";
import { addDays, dateChoices, dayLabel, parseDate, parseTime, resolveDate, shortTime, torontoLabel, torontoToDate, torontoToday } from "./time.js";
import { findSlots, loadAvailability, type Size } from "./availability.js";
import { bookingLink, dimensions, type Format, FORMATS } from "./venues.js";
import { reserveButtonId } from "./reserve.js";

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

  // A poll for the same day? Its "I'm in" voters get a DM once the game is posted.
  const fromPoll = await pollForDay(torontoToday(new Date(match.kickoff_time)));

  const channelId = env("GAMES_CHANNEL_ID");
  const opened: Match = { ...match, status: "OPEN", channel_id: channelId, poll_id: fromPoll?.poll.poll_id ?? null };
  const message = await discord<{ id: string }>("POST", `/channels/${channelId}/messages`, lobbyMessage(opened, await rosterOf(matchId)));
  opened.message_id = message.id;

  await sql`
    UPDATE matches SET status = 'OPEN', channel_id = ${channelId}, message_id = ${message.id},
                       poll_id = ${opened.poll_id}
    WHERE match_id = ${matchId}`;

  let note = "";
  if (fromPoll) {
    const dmed = await invitePollVoters(fromPoll.poll, opened, fromPoll.voterIds);
    const total = fromPoll.voterIds.length;
    note = total
      ? `\n🗳️ Told ${total === 1 ? "the 1 poll voter" : `the ${total} poll voters`} who said I'm in (${dmed} by DM${dmed < total ? `, ${total - dmed} mentioned in the channel` : ""}).`
      : `\n🗳️ Closed the poll for that day (no one had said I'm in).`;
  }
  // #games only shows the newest game: remove SORY's older posts there.
  const stillOpen = await clearGamesChannel(channelId, message.id, interaction.application_id);
  if (stillOpen.length) {
    note += `\n-# Older open game${stillOpen.length === 1 ? "" : "s"} ${stillOpen.map((n) => `#${n}`).join(", ")} left #games. Their paid players can still leave from their receipt DM.`;
  }
  await reply(`✅ Match #${matchId} is open and posted in <#${channelId}>.${note}`);
  await botLog(
    `📣 <@${interaction.member!.user.id}> posted Match #${matchId}: ${match.facility_name} · ${match.court_name}, ${torontoLabel(new Date(match.kickoff_time))}, ${money(match.checkout_price_cents)}/player`,
  );
}

/**
 * Deletes SORY's posts in #games except the new game card (older cards, old lists, mentions), and
 * forgets the deleted cards. Returns the numbers of games that are still open but no longer shown.
 */
async function clearGamesChannel(channelId: string, keepId: string, botId: string): Promise<number[]> {
  const old: string[] = [];
  let before = "";
  for (let page = 0; page < 10; page++) {
    const batch = await discord<{ id: string; author: { id: string } }[]>("GET", `/channels/${channelId}/messages?limit=100${before && `&before=${before}`}`);
    old.push(...batch.filter((m) => m.id !== keepId && m.author.id === botId).map((m) => m.id));
    if (batch.length < 100) break;
    before = batch[batch.length - 1].id;
  }
  for (const id of old) {
    await discord("DELETE", `/channels/${channelId}/messages/${id}`).catch((err) => console.error("Couldn't delete an old #games post", err));
  }
  if (!old.length) return [];
  const hidden = await sql<{ match_id: number; status: string }[]>`
    UPDATE matches SET message_id = NULL WHERE channel_id = ${channelId} AND message_id IN ${sql(old)} RETURNING match_id, status`;
  return hidden.filter((m) => m.status === "OPEN").map((m) => m.match_id);
}

const DEFAULT_DAYS = 7;
const MAX_SLOTS_SHOWN = 25; // Discord allows 25 fields and 25 buttons per message
const EMBED_CHAR_BUDGET = 5600; // Discord allows 6000 characters per message's embeds; keep some room

/**
 * /available: open Mississauga turf with total cost and per-player price. Anyone can run it and the
 * list is posted for everyone, but the same unchanged list is never posted twice in a channel.
 * Runs after a private deferred reply, which carries errors and "no changes" notes.
 */
export async function available(interaction: Interaction): Promise<void> {
  const reply = (body: object) => editReply(interaction, { allowed_mentions: { parse: [] }, ...body });

  const format = (option<string>(interaction, "format") ?? "9v9") as Format;
  const { size, perSide } = FORMATS[format] ?? FORMATS["9v9"];
  const length = option<number>(interaction, "length") ?? DEFAULT_DURATION_MINUTES;
  const players = option<number>(interaction, "players") ?? perSide * 2;
  const afterText = option<string>(interaction, "after") ?? "5pm";
  // Domes count as indoor: the City lists each dome as its own indoor fields and closes them while the
  // dome is down for summer, when the outdoor field underneath opens instead. So this holds all year.
  const where = (option<string>(interaction, "where") ?? "both") as "both" | "indoor" | "outdoor";
  const fromText = option<string>(interaction, "from");
  const toText = option<string>(interaction, "to");

  const after = parseTime(afterText);
  if (!after) return void (await reply({ content: "I couldn't read that time. Use something like 5pm or 17:00." }));
  const afterMinute = after[0] * 60 + after[1];

  // Dates: from (default tomorrow) to (default a week later), inside the online booking window.
  const { first, last } = bookingWindow();
  const from = fromText ? resolveDate(fromText, first, last) : first;
  if (!from) return void (await reply({ content: `I couldn't read the from date "${fromText}". Pick one from the list.` }));
  const to = toText ? resolveDate(toText, first, last) : minDate(addDays(from, DEFAULT_DAYS - 1), last);
  if (!to) return void (await reply({ content: `I couldn't read the to date "${toText}". Pick one from the list.` }));
  if (from < first || to > last) {
    return void (await reply({ content: `Online booking only covers ${dayLabel(first)} to ${dayLabel(last)} (at least 24 hours and at most 30 days ahead).` }));
  }
  if (to < from) return void (await reply({ content: `The to date (${dayLabel(to)}) is before the from date (${dayLabel(from)}).` }));
  const dates: string[] = [];
  for (let ymd = from; ymd <= to; ymd = addDays(ymd, 1)) dates.push(ymd);

  const snapshot = await loadAvailability();
  const found = dates.flatMap((ymd) =>
    findSlots(snapshot, ymd, size, length, afterMinute)
      .filter((slot) => where === "both" || (where === "outdoor") === !!slot.venue.outdoor)
      .map((slot) => ({ ymd, slot })),
  );
  const sizeLabel = { quarter: "Quarter field", half: "Half field", full: "Full field" }[size];

  // One short card per start time, earliest first. Venue size and links go once in the description.
  const whereLabel = { both: "", indoor: " · indoor only", outdoor: " · outdoor only" }[where];
  const header = `${format} · ${sizeLabel.toLowerCase()}${whereLabel} · ${length} min · after ${shortTime(afterMinute)} EST · ${players} players`;
  const note = "-# Price per player includes the card fee. Totals include HST. Resident rates. Only organizers can reserve.";
  const card = ({ ymd, slot: s }: (typeof found)[number], i: number) => ({
    name: `${i + 1}. 📅 ${dayLabel(ymd).replace(",", "")} · 🕐 ${shortTime(s.start)}–${shortTime(s.start + length)} · 📍 ${s.venue.name} ${s.label}`,
    value: `💵 **${money(priceFor(s.cost.totalCents, players).checkoutCents)}/player** · ${money(s.cost.totalCents)} total · ${s.cost.rate} · [Book](${bookingLink(s.resourceIds[0])})`,
  });
  const venueLine = (v: (typeof found)[number]["slot"]["venue"]) =>
    `📍 **${v.name}** · ${dimensions(v, size)}${v.pitch.estimated ? " (est.)" : ""} · ${v.links.map((l) => `[${l.label}](${l.url})`).join(" · ")}`;

  // Show as many as fit in one message.
  const shown: typeof found = [];
  const fields: { name: string; value: string }[] = [];
  let used = header.length + note.length + 300; // title, footer and the "showing" line
  const venuesShown = new Set<string>();
  for (const item of found) {
    if (shown.length >= MAX_SLOTS_SHOWN) break;
    const f = card(item, shown.length);
    const extra = venuesShown.has(item.slot.venue.name) ? 0 : venueLine(item.slot.venue).length + 1;
    if (used + f.name.length + f.value.length + extra > EMBED_CHAR_BUDGET) break;
    used += f.name.length + f.value.length + extra;
    venuesShown.add(item.slot.venue.name);
    shown.push(item);
    fields.push(f);
  }
  const venues = [...new Map(shown.map(({ slot }) => [slot.venue.name, slot.venue])).values()].map(venueLine).join("\n");

  const range = dates.length === 1 ? dayLabel(dates[0]) : `${dayLabel(dates[0])} – ${dayLabel(dates[dates.length - 1])}`;
  const more =
    found.length > shown.length
      ? `\nShowing the first ${shown.length} of ${found.length} · for later ones, use a later \`after:\` or \`from:\``
      : "";
  const checked = Math.floor(snapshot.oldestFetch.getTime() / 1000);
  const list = {
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `🔎 ${found.length} open · ${range}`,
        description: found.length
          ? `${header}\n${venues}\n${note}${more}`
          : `No ${where === "both" ? "" : `${where} `}openings for ${format} after ${shortTime(afterMinute)}. Try another day, an earlier time, ${where === "both" ? "or a smaller format" : "a smaller format, or indoor and outdoor"}.`,
        color: 0x3498db,
        fields,
        footer: { text: `Asked by ${displayName(interaction)} · Source: Active Mississauga${snapshot.stale ? " · ⚠️ some data may be out of date" : ""} · checked` },
        timestamp: new Date(checked * 1000).toISOString(),
      },
    ],
    // "📝 Reserve 1" … under the cards: saves that slot as a draft game with booking steps.
    components: chunk(
      shown.map(({ ymd, slot: s }, i) => ({
        type: 2,
        style: 1,
        label: `📝 Reserve ${i + 1}`,
        custom_id: reserveButtonId({ resourceIds: s.resourceIds, ymd, startMinute: s.start, lengthMinutes: length, format, players }),
      })),
      5,
    ).map((buttons) => ({ type: 1, components: buttons })),
  };

  // Same search, same openings and prices as the last list in this channel: point to it instead of reposting.
  const searchKey = [format, length, afterMinute, players, from, to, where].join("|");
  const resultsHash = createHash("sha256")
    .update(JSON.stringify(found.map(({ ymd, slot: s }) => [ymd, s.resourceIds, s.start, s.cost.totalCents])))
    .digest("hex");
  await postOnce(interaction, searchKey, resultsHash, list, reply);
}

/** Posts `list` in the channel unless the same search with the same results is already there. */
async function postOnce(interaction: Interaction, searchKey: string, resultsHash: string, list: object, reply: (body: object) => Promise<unknown>) {
  const channelId = interaction.channel_id!;
  const [last] = await sql<{ results_hash: string; message_id: string }[]>`
    SELECT results_hash, message_id FROM posted_lists WHERE channel_id = ${channelId} AND search_key = ${searchKey}`;
  if (last?.results_hash === resultsHash && (await messageExists(channelId, last.message_id))) {
    const link = `https://discord.com/channels/${interaction.guild_id}/${channelId}/${last.message_id}`;
    return void (await reply({ content: `Nothing has changed since the last list, so I didn't post it again: ${link}` }));
  }

  let message: { id: string };
  try {
    message = await discord<{ id: string }>("POST", `/channels/${channelId}/messages`, list);
  } catch (err) {
    // No permission to post here: show the list to the person who asked instead.
    console.error(err);
    return void (await reply({ ...list, content: "-# I can't post in this channel, so only you can see this." }));
  }
  await sql`
    INSERT INTO posted_lists (channel_id, search_key, results_hash, message_id, posted_at)
    VALUES (${channelId}, ${searchKey}, ${resultsHash}, ${message.id}, now())
    ON CONFLICT (channel_id, search_key) DO UPDATE
      SET results_hash = EXCLUDED.results_hash, message_id = EXCLUDED.message_id, posted_at = EXCLUDED.posted_at`;
  await deleteReply(interaction).catch(() => reply({ content: "✅ Posted." }));
}

async function messageExists(channelId: string, messageId: string): Promise<boolean> {
  try {
    await discord("GET", `/channels/${channelId}/messages/${messageId}`);
    return true;
  } catch {
    return false; // deleted, or can't be read any more
  }
}

/** Online booking on Active Mississauga: at least 24 hours and at most 30 days ahead. */
function bookingWindow() {
  const today = torontoToday();
  return { first: addDays(today, 1), last: addDays(today, 30) };
}

const minDate = (a: string, b: string) => (a < b ? a : b);

/** Date pickers on /available (from, to) and /reserve (date): bookable days that match what's typed. */
export function dateAutocomplete(interaction: Interaction): { name: string; value: string }[] {
  const focused = interaction.data?.options?.find((o) => o.focused);
  if (!focused) return [];
  let { first, last } = bookingWindow();
  if (focused.name === "to") {
    // Start the "to" list at the chosen "from" day.
    const fromText = option<string>(interaction, "from");
    const from = fromText ? resolveDate(fromText, first, last) : null;
    if (from && from >= first && from <= last) first = from;
  }
  return dateChoices(String(focused.value ?? ""), first, last);
}

function chunk<T>(items: T[], size: number): T[][] {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, i * size + size));
}

/** /cancel: asks the organizer to confirm, showing who gets refunded. Organizers only. */
export async function cancelPrompt(interaction: Interaction): Promise<Reply & { components?: unknown[] }> {
  if (!isOrganizer(interaction)) return privateReply("Only organizers can cancel games.");
  const matchId = option<number>(interaction, "match")!;
  const reason = (option<string>(interaction, "reason") ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  const preview = await cancelPreview(matchId);
  if (!preview) return privateReply(`There's no Match #${matchId}.`);
  const { match, paidPlayers, refundCents, others } = preview;
  if (match.status === "CANCELLED") return privateReply(`Match #${matchId} is already cancelled.`);
  if (match.status === "LOCKED" || new Date(match.kickoff_time).getTime() <= Date.now()) {
    return privateReply(`Match #${matchId} has already started, so it can't be cancelled.`);
  }
  const effects = [
    paidPlayers ? `refund ${paidPlayers} paid player${paidPlayers === 1 ? "" : "s"} **${money(refundCents)}** in total (everything they paid)` : "no one has paid yet",
    others ? `clear ${others} hold${others === 1 ? "" : "s"} and waitlist spot${others === 1 ? "" : "s"}` : "",
    match.status === "OPEN" ? "mark the card in #games as cancelled and DM every player" : "",
  ].filter(Boolean);
  return {
    content: [
      `Cancel **Match #${matchId}**, ${match.facility_name} · ${match.court_name}, ${torontoLabel(new Date(match.kickoff_time))}${reason ? ` (${reason})` : ""}?`,
      `This will ${effects.join(", ")}. It can't be undone.`,
    ].join("\n"),
    flags: EPHEMERAL,
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 4, label: "Yes, cancel the game", custom_id: `cancel-yes:${matchId}:${reason}` },
          { type: 2, style: 2, label: "Keep it", custom_id: `cancel-no:${matchId}` },
        ],
      },
    ],
  };
}

/** /roster: the full roster with payments, privately. Organizers only. */
export async function roster(interaction: Interaction): Promise<Reply> {
  if (!isOrganizer(interaction)) return privateReply("Only organizers can see the full roster.");
  return privateReply(await rosterReport(option<number>(interaction, "match")!));
}

function privateReply(content: string): Reply {
  return { content, flags: EPHEMERAL };
}
